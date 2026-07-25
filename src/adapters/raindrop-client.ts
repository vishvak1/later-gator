import { z } from "zod";
import { readBoundedJsonResponse } from "./bounded-json-response";

const BASE_URL = "https://api.raindrop.io/rest/v1/";
const MAX_RESPONSE_BYTES = 512_000;
const MAX_PAGE_SIZE = 50;
const MAX_READ_ATTEMPTS = 3;

const UserEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  user: z.object({
    _id: z.number().int().positive(),
    fullName: z.string(),
  }),
});
const CollectionSchema = z.looseObject({
  _id: z.number().int().positive(),
  title: z.string(),
  count: z.number().int().nonnegative(),
  parent: z.looseObject({ $id: z.number().int().positive() }).optional(),
  user: z.looseObject({ $id: z.number().int().positive() }),
  access: z.looseObject({ level: z.number().int() }),
});
const CollectionsEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  items: z.array(CollectionSchema),
});
const RaindropSchema = z.looseObject({
  _id: z.number().int().positive(),
  collection: z.looseObject({ $id: z.number().int() }),
  title: z.string(),
  link: z.url(),
  excerpt: z.string().default(""),
  note: z.string().default(""),
  tags: z.array(z.string()).default([]),
  created: z.iso.datetime(),
  lastUpdate: z.iso.datetime().optional(),
  type: z.string().optional(),
});
const RaindropsEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  items: z.array(RaindropSchema),
  count: z.number().int().nonnegative().optional(),
});
const RaindropEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  item: RaindropSchema,
});
const CollectionEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  item: CollectionSchema,
});
const ResultEnvelopeSchema = z.looseObject({ result: z.literal(true) });
const FiltersEnvelopeSchema = z.looseObject({
  result: z.literal(true),
  notag: z.looseObject({ count: z.number().int().nonnegative() }),
  tags: z.array(
    z.looseObject({
      _id: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  types: z.array(
    z.looseObject({
      _id: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export interface RaindropUser {
  id: number;
  fullName: string;
}

export interface RaindropCollection {
  id: number;
  title: string;
  count: number;
  parentId: number | null;
  userId: number;
  accessLevel: number;
}

export interface RaindropItem {
  id: number;
  collectionId: number;
  title: string;
  link: string;
  excerpt: string;
  note: string;
  tags: string[];
  created: string;
  lastUpdate: string | null;
  type: string | null;
}

export interface RaindropPage {
  items: RaindropItem[];
  totalCount: number | null;
}

export interface RaindropFilters {
  untaggedCount: number;
  tags: { name: string; count: number }[];
  totalByType: number;
}

export class RaindropHttpError extends Error {
  override readonly name = "RaindropHttpError";

  constructor(
    readonly status: number,
    readonly retryAt: string | null,
  ) {
    super(`Raindrop request failed with ${status.toString()}`);
  }
}

export class RaindropResponseError extends Error {
  override readonly name = "RaindropResponseError";

  constructor() {
    super("Raindrop returned an unreadable response");
  }
}

export class RaindropNetworkError extends Error {
  override readonly name = "RaindropNetworkError";

  constructor(readonly attempts: number) {
    super(`Raindrop network request failed after ${attempts.toString()} attempts`);
  }
}

export class RaindropClient {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async getCurrentUser(): Promise<RaindropUser> {
    const envelope = UserEnvelopeSchema.parse(await this.call("user"));
    return { id: envelope.user._id, fullName: envelope.user.fullName };
  }

  async listCollections(): Promise<RaindropCollection[]> {
    const [root, children] = await Promise.all([
      this.call("collections"),
      this.call("collections/childrens"),
    ]);
    const items = [
      ...CollectionsEnvelopeSchema.parse(root).items,
      ...CollectionsEnvelopeSchema.parse(children).items,
    ];
    return items.map(projectCollection);
  }

  async listRaindrops(
    collectionId: number,
    options: {
      page?: number;
      perPage?: number;
      search?: string;
      sort?: string;
      nested?: boolean;
    } = {},
  ): Promise<RaindropPage> {
    const page = z.number().int().nonnegative().parse(options.page ?? 0);
    const perPage = z.number().int().min(1).max(MAX_PAGE_SIZE).parse(options.perPage ?? 50);
    const url = this.url(`raindrops/${z.number().int().parse(collectionId).toString()}`);
    url.searchParams.set("page", page.toString());
    url.searchParams.set("perpage", perPage.toString());
    if (options.search !== undefined) url.searchParams.set("search", options.search);
    if (options.sort !== undefined) url.searchParams.set("sort", options.sort);
    if (options.nested !== undefined) url.searchParams.set("nested", String(options.nested));

    const envelope = RaindropsEnvelopeSchema.parse(await this.call(url));
    return {
      items: envelope.items.map(projectRaindrop),
      totalCount: envelope.count ?? null,
    };
  }

  async countRaindrops(collectionId: number): Promise<number> {
    const first = await this.listRaindrops(collectionId, { page: 0, perPage: 50 });
    if (first.totalCount !== null) return first.totalCount;

    let count = first.items.length;
    let page = 1;
    let current = first;
    while (current.items.length === MAX_PAGE_SIZE) {
      current = await this.listRaindrops(collectionId, { page, perPage: 50 });
      count += current.items.length;
      page += 1;
    }
    return count;
  }

  async getRaindrop(id: number): Promise<RaindropItem> {
    const safeId = z.number().int().positive().parse(id);
    const envelope = RaindropEnvelopeSchema.parse(
      await this.call(`raindrop/${safeId.toString()}`),
    );
    return projectRaindrop(envelope.item);
  }

  async moveRaindrops(
    sourceCollectionId: number,
    idsInput: number[],
    destinationCollectionId: number,
  ): Promise<void> {
    const sourceId = z.number().int().parse(sourceCollectionId);
    const destinationId = z.number().int().parse(destinationCollectionId);
    const ids = z.array(z.number().int().positive()).min(1).max(100).parse(idsInput);
    ResultEnvelopeSchema.parse(
      await this.call(`raindrops/${sourceId.toString()}`, {
        method: "PUT",
        body: JSON.stringify({
          ids,
          collection: { $id: destinationId },
        }),
      }),
    );
  }

  async clearRaindropTags(collectionId: number, idsInput: number[]): Promise<void> {
    const safeCollectionId = z.number().int().parse(collectionId);
    const ids = z.array(z.number().int().positive()).min(1).max(100).parse(idsInput);
    ResultEnvelopeSchema.parse(
      await this.call(`raindrops/${safeCollectionId.toString()}`, {
        method: "PUT",
        body: JSON.stringify({ ids, tags: [] }),
      }),
    );
  }

  async updateRaindrop(
    id: number,
    update: {
      collectionId: number;
      tags: string[];
      excerpt: string;
      note: string;
      link?: string;
      title?: string;
    },
  ): Promise<RaindropItem> {
    const safeId = z.number().int().positive().parse(id);
    const body = {
      collection: { $id: z.number().int().positive().parse(update.collectionId) },
      tags: z.array(z.string().min(1).max(100)).max(8).parse(update.tags),
      excerpt: z.string().max(10_000).parse(update.excerpt),
      note: z.string().max(10_000).parse(update.note),
      ...(update.link === undefined ? {} : { link: z.url().parse(update.link) }),
      ...(update.title === undefined
        ? {}
        : { title: z.string().min(1).max(1_000).parse(update.title) }),
    };
    const envelope = RaindropEnvelopeSchema.parse(
      await this.call(`raindrop/${safeId.toString()}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
    return projectRaindrop(envelope.item);
  }

  async createCollection(titleInput: string): Promise<RaindropCollection> {
    const title = z.string().trim().min(1).max(200).parse(titleInput);
    const envelope = CollectionEnvelopeSchema.parse(
      await this.call("collection", {
        method: "POST",
        body: JSON.stringify({ title, view: "list", public: false }),
      }),
    );
    return projectCollection(envelope.item);
  }

  async deleteCollection(id: number): Promise<void> {
    const safeId = z.number().int().positive().parse(id);
    ResultEnvelopeSchema.parse(
      await this.call(`collection/${safeId.toString()}`, { method: "DELETE" }),
    );
  }

  async getFilters(collectionId: number, search?: string): Promise<RaindropFilters> {
    const safeId = z.number().int().parse(collectionId);
    const url = this.url(`filters/${safeId.toString()}`);
    if (search !== undefined) url.searchParams.set("search", search);
    const envelope = FiltersEnvelopeSchema.parse(await this.call(url));
    return {
      untaggedCount: envelope.notag.count,
      tags: envelope.tags.map((tag) => ({ name: tag._id, count: tag.count })),
      totalByType: envelope.types.reduce((sum, type) => sum + type.count, 0),
    };
  }

  private url(path: string): URL {
    return new URL(path, BASE_URL);
  }

  private async call(pathOrUrl: string | URL, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    const response = await this.send(
      typeof pathOrUrl === "string" ? this.url(pathOrUrl) : pathOrUrl,
      { ...init, headers },
    );
    let payload: unknown;
    try {
      payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
    } catch {
      if (!response.ok) throw new RaindropHttpError(response.status, retryAt(response));
      throw new RaindropResponseError();
    }
    if (!response.ok) throw new RaindropHttpError(response.status, retryAt(response));
    return payload;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const maxAttempts = method === "GET" ? MAX_READ_ATTEMPTS : 1;
    const request = this.request;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await request(url, init);
      } catch {
        if (attempt === maxAttempts) {
          throw new RaindropNetworkError(attempt);
        }
      }
    }

    throw new RaindropNetworkError(maxAttempts);
  }
}

function projectCollection(
  item: z.infer<typeof CollectionSchema>,
): RaindropCollection {
  return {
    id: item._id,
    title: item.title,
    count: item.count,
    parentId: item.parent?.$id ?? null,
    userId: item.user.$id,
    accessLevel: item.access.level,
  };
}

function projectRaindrop(item: z.infer<typeof RaindropSchema>): RaindropItem {
  return {
    id: item._id,
    collectionId: item.collection.$id,
    title: item.title,
    link: item.link,
    excerpt: item.excerpt,
    note: item.note,
    tags: item.tags,
    created: item.created,
    lastUpdate: item.lastUpdate ?? null,
    type: item.type ?? null,
  };
}

function retryAt(response: Response): string | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(Date.now() + seconds * 1_000).toISOString();
    }
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0
    ? new Date(reset * 1_000).toISOString()
    : null;
}
