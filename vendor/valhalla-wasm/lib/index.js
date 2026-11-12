/**
 * Valhalla's routing engine in WebAssembly.
 *
 * Requests and responses are Valhalla's own JSON, as its HTTP service takes
 * and returns them (https://valhalla.github.io/valhalla/api/). Graph tiles
 * come from a {@link TileSource} you provide: the engine asks for a tile by
 * its path when it needs it, synchronously, so the source has to hold its
 * tiles in memory (or read them synchronously). Run the engine in a Web
 * Worker: a route search blocks the thread it runs on.
 */
import defaultConfig from "./default-config.json" with { type: "json" };
import { tilePath } from "./tiles.js";
export { tilePath, tileId, tilesInBounds, TILE_LEVELS } from "./tiles.js";
/** A {@link TileSource} holding tiles in memory. */
export class MemoryTileSource {
    #tiles = new Map();
    get(path) {
        return this.#tiles.get(path);
    }
    /** Add or replace a tile by path. */
    set(path, bytes) {
        this.#tiles.set(path, bytes);
        return this;
    }
    /** Add or replace a tile by level and id. */
    setTile(level, id, bytes) {
        return this.set(tilePath(level, id), bytes);
    }
    has(path) {
        return this.#tiles.has(path);
    }
    delete(path) {
        return this.#tiles.delete(path);
    }
    /** Drop every tile. */
    clear() {
        this.#tiles.clear();
    }
    /** The paths of the tiles held. */
    keys() {
        return this.#tiles.keys();
    }
    /** Number of tiles held. */
    get size() {
        return this.#tiles.size;
    }
    /** Total bytes held. */
    get bytes() {
        let n = 0;
        for (const t of this.#tiles.values())
            n += t.byteLength;
        return n;
    }
}
/** An error Valhalla answered with, as its HTTP service would. */
export class ValhallaError extends Error {
    /** Valhalla's error code (e.g. 171 "No suitable edges near location"). */
    code;
    /** The HTTP status the service would have sent. */
    status;
    /** Its text ("Bad Request"). */
    statusText;
    constructor(code, status, message, statusText = "") {
        super(message);
        this.name = "ValhallaError";
        this.code = code;
        this.status = status;
        this.statusText = statusText;
    }
}
function merge(base, over) {
    if (over === null ||
        typeof over !== "object" ||
        Array.isArray(over) ||
        base === null ||
        typeof base !== "object" ||
        Array.isArray(base)) {
        return over === undefined ? base : over;
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        out[k] = merge(out[k], v);
    }
    return out;
}
function parse(json) {
    const out = JSON.parse(json);
    if (out && typeof out === "object" && "error_code" in out && "error" in out && !("trip" in out)) {
        throw new ValhallaError(out.error_code, out.status_code ?? 400, out.error, out.status ?? "");
    }
    return out;
}
const text = (request) => (typeof request === "string" ? request : JSON.stringify(request));
/** Load the engine and configure it. */
export async function loadValhalla(options) {
    const { default: createModule } = await import("../dist/valhalla.mjs");
    const wasmUrl = options.wasmUrl?.toString();
    const m = await createModule(wasmUrl ? { locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : file) } : {});
    m.tileSource = options.tiles;
    const err = m.init(JSON.stringify(merge(defaultConfig, options.config ?? {})));
    if (err)
        throw new Error(`valhalla-wasm: ${err}`);
    return {
        route: (r) => parse(m.route(text(r))),
        traceRoute: (r) => parse(m.traceRoute(text(r))),
        locate: (r) => parse(m.locate(text(r))),
        reset() {
            const e = m.reset();
            if (e)
                throw new Error(`valhalla-wasm: ${e}`);
        },
        get memoryBytes() {
            return m.HEAP8.byteLength;
        },
    };
}
