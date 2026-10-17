import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { RemoteSocketStream, connectSecureChannel, createDeviceIdentity, deviceIdentityId } from "@cherrystudio/remote-transport";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { jsonRpcNotificationSchema, jsonRpcRequestSchema, jsonRpcResponseSchema, remoteConnectPath, remoteFailureSchema } from "@cherrystudio/remote-protocol";
const FILE_MODE = 384;
/**
* Version-to-version migrations, keyed by the version they upgrade from.
*
* `{ 1 -> 2 }` is a mechanism sample only, mirroring the plan's convention that
* real schema evolution starts at version 2 after release. A v1 archive is the
* current field set minus `schemaVersion`.
*/
const MIGRATIONS = { 1: (record) => ({
	...record,
	schemaVersion: 2
}) };
/**
* Every field of the *current* set except `schemaVersion` — v1 is defined as
* the current field set minus the version key, so these are exactly the keys a
* complete v1 archive must carry.
*/
const V1_KEYS = [
	"deviceId",
	"displayName",
	"hosts",
	"port",
	"desktopIdentity",
	"grants",
	"enabled"
];
const REQUIRED_KEYS = [...V1_KEYS, "schemaVersion"];
/**
* A version-less entry reads as the legacy (v1) shape only when every v1 field
* is present. A missing `schemaVersion` alone means v1; a missing
* `schemaVersion` plus missing fields means corruption, and the entry must be
* rejected rather than migrated.
*/
function hasCompleteFieldSet(disk) {
	return V1_KEYS.every((key) => disk[key] !== void 0);
}
/** Asserts the required `DeviceRecord` shape. The read path's exit. */
function assertValidRecord(disk) {
	if (disk.schemaVersion !== 2) throw new Error(`device archive entry has unsupported schemaVersion ${String(disk.schemaVersion)}; expected 2`);
	const missing = REQUIRED_KEYS.filter((key) => disk[key] === void 0);
	if (missing.length > 0) throw new Error(`device archive entry is missing required field(s): ${missing.join(", ")}`);
	if (!Array.isArray(disk.hosts)) throw new Error("device archive entry field hosts must be an array");
	if (disk.accessToken !== void 0 !== (disk.tokenExpiresAt !== void 0)) throw new Error("device archive entry must carry accessToken and tokenExpiresAt together or not at all");
	return disk;
}
/**
* Read path, fixed order: loose parse -> completeness gate -> version judgement
* -> migration -> assert the required `DeviceRecord` type.
*
* `archiveVersion` is the single migration authority: it decides the migration
* chain for every entry, and an entry's own `schemaVersion` is inert — present
* only as a cross-check against the archive, never to drive migration, version
* rejection, or a version-less default of its own.
*
* A version-less entry is the legacy (v1) shape, valid only inside a
* schemaVersion-1 archive; under any newer archive it is rejected.
*
* `archiveVersion` is always a version this build understands, because
* {@link parseArchive} rejects unknown archive versions before reaching here.
*/
function parseRecord(raw, archiveVersion) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("device archive entry must be a JSON object");
	const disk = raw;
	const declared = disk.schemaVersion;
	if (declared === void 0 && !hasCompleteFieldSet(disk)) throw new Error("device archive entry has no schemaVersion and an incomplete field set; only a complete field set may be read as a legacy (v1) entry");
	if (declared === void 0 && archiveVersion > 1) throw new Error(`device archive entry has no schemaVersion but its archive is schemaVersion ${archiveVersion}; legacy (v1) entries are only valid inside a schemaVersion-1 archive`);
	if (declared !== void 0 && declared !== archiveVersion) throw new Error(`device archive entry declares schemaVersion ${declared} but its archive is schemaVersion ${archiveVersion}; the archive version is authoritative`);
	let migrated = disk;
	for (let step = archiveVersion; step < 2; step += 1) {
		const migrate = MIGRATIONS[step];
		if (migrate === void 0) throw new Error(`no migration registered from device archive schemaVersion ${step}`);
		migrated = migrate(migrated);
	}
	return assertValidRecord(migrated);
}
function parseArchive(parsed) {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("device archive must be a JSON object");
	const archive = parsed;
	if (typeof archive.schemaVersion !== "number") throw new Error("device archive is missing a numeric schemaVersion");
	if (archive.schemaVersion > 2) throw new Error(`device archive declares schemaVersion ${archive.schemaVersion}, newer than supported 2; refusing to read it`);
	if (!Array.isArray(archive.devices)) throw new Error("device archive is missing a devices array");
	const archiveVersion = archive.schemaVersion;
	return {
		schemaVersion: archiveVersion,
		devices: archive.devices.map((record) => parseRecord(record, archiveVersion))
	};
}
function serializeArchive(devices) {
	return `${JSON.stringify({
		schemaVersion: 2,
		devices
	}, null, 2)}\n`;
}
/**
* Reads the archive at `file`, degrading to "unreadable" at the FILE layer
* only, and letting semantic rejections propagate.
*
* Graceful (empty archive + warning, never a throw):
*  - a MISSING file (ENOENT) — first-run has no archive yet, and an archive
*    deleted underneath the plugin must not take it down. This is the one
*    read failure that leaves the store writable: there is nothing to lose.
*
* Quarantined (empty read-only view + warning, see {@link QuarantinedArchiveError}):
*  - any OTHER read failure (EACCES/EBUSY/EIO/…), and
*  - bytes that are not parsable JSON.
*
*  Both mean the same thing — bytes exist on disk that this build cannot read
*  — so neither may be treated as "empty". Degrading a corrupt archive to an
*  empty one and then overwriting it destroys every pairing and token in it,
*  unrecoverably. Instead the bad file is COPIED to `<file>.corrupt` (best
*  effort, the original is never moved or truncated), an empty read-only view
*  is served, and the store is poisoned so {@link DeviceStore} refuses to
*  write until an operator moves the bad file aside.
*
* Rejected (thrown to the caller), because a readable archive that declares
* something this build cannot honour must never be silently discarded:
*  - a version-less entry with an incomplete field set;
*  - an unknown higher `schemaVersion`.
*/
function readArchive(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (isNotFound(error)) {
			console.info(`device archive ${file} does not exist yet; starting from an empty archive`);
			return;
		}
		throw new QuarantinedArchiveError(file, error);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new QuarantinedArchiveError(file, error);
	}
	return parseArchive(parsed);
}
/** ENOENT is the only "there is nothing here yet" read failure. */
function isNotFound(error) {
	return error?.code === "ENOENT";
}
/** A JSON error's message, for the operator-facing half of the throw. */
function reasonOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The one recovery instruction for a quarantined archive, shared by every face
* that reports it (the HTTP 503 body, the SSE `archive-quarantined` stage, and
* `cherry_pair`'s structured result).
*
* It lives beside the error because the error is the only thing that knows the
* condition, and three independently-worded copies of "move the file aside"
* would drift into three different instructions the first time one is edited.
*/
const QUARANTINE_RECOVERY = "the device archive cannot be read and the plugin will not overwrite it; move the bad file aside (then restart or re-apply the plugin) to resume device management";
/**
* The structured write-refusal raised by an archive the store could not read.
*
* It is deliberately NOT a plain {@link Error}: the assembly and the HTTP API
* distinguish "this device is unavailable" from "the archive must be repaired
* by hand", and the latter is only safe to report if the operator is told
* exactly which two files to look at. Nothing in this build ever deletes the
* two paths named here.
*/
var QuarantinedArchiveError = class QuarantinedArchiveError extends Error {
	/** The archive that could not be read; still on disk, byte-for-byte. */
	file;
	/** The best-effort preservation copy, or `undefined` when the copy failed. */
	corruptPath;
	/** The underlying read/parse failure the quarantine was raised for. */
	cause;
	constructor(file, cause, corruptPath) {
		super(`device archive ${file} is unreadable (${reasonOf(cause)}); it was preserved as ${corruptPath ?? `${file}.corrupt`} and the store is now READ-ONLY — refusing to overwrite it, because that would destroy every pairing and stored token. Move the bad file aside to resume writing.`);
		this.name = "QuarantinedArchiveError";
		this.file = file;
		this.corruptPath = corruptPath;
		this.cause = cause;
		Object.setPrototypeOf(this, new.target.prototype);
	}
	/**
	* The same failure, describing the preservation copy that was actually made.
	* The read path can only name the path it WOULD copy to; the store re-raises
	* with the path it DID, so an operator is never sent to a file that does not
	* exist (the copy is best effort).
	*/
	withCorruptPath(corruptPath) {
		return new QuarantinedArchiveError(this.file, this.cause, corruptPath);
	}
};
/**
* Preserves an unreadable archive as `<file>.corrupt` (best effort — a failed
* copy must not mask the original problem) and returns the path it landed at.
*/
function quarantine(file) {
	const target = `${file}.corrupt`;
	try {
		copyFileSync(file, target);
		chmodSync(target, FILE_MODE);
		return target;
	} catch (error) {
		console.warn(`device archive ${file} could not be preserved as ${target}:`, error);
		return;
	}
}
/**
* Writes the archive atomically and flushes it to disk.
*
* The archive is serialized into `<file>.tmp`, fsynced, and only then renamed
* over the target. `renameSync` is atomic within one filesystem, so an observer
* (including the next process to start) sees either the whole old archive or
* the whole new one — never the truncated middle. Truncating the target in
* place is what turns a crash or a full disk into an unparsable archive, and
* that is exactly the destruction chain the quarantine path exists to stop.
*
* `mode` only applies when a file is created, and `rename` carries the temp
* file's own mode over to the target, so the temp file is chmod'd explicitly:
* both halves of the swap are 0600, and a pre-existing looser archive is
* re-tightened by the rename rather than left as it was.
*
* `fsync` follows the plan's write-path requirement: a crash must not be able
* to acknowledge a pairing that never reached the disk. The rename itself is
* what makes the *name* switch durable; the data was already flushed before it.
*
* File I/O is synchronous because the store's API is synchronous (per the
* plan's Interfaces) — `list`/`resolve` consume the store directly.
*/
function persistArchive(file, devices) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	const fd = openSync(temp, "w", FILE_MODE);
	try {
		writeSync(fd, serializeArchive(devices), void 0, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(temp, FILE_MODE);
	try {
		renameSync(temp, file);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}
/**
* Versioned archive of paired devices, persisted as one 0600 JSON file.
*
* Crash durability: every write is atomic — serialized to `<file>.tmp`, fsynced,
* then renamed over the target — so a crash at any point leaves either the old
* archive or the new one, never a truncated one.
*
* Reads are lazy and synchronous: the archive is loaded on first use and
* migrated to {@link CURRENT_SCHEMA_VERSION} — written back only when the
* stored version actually trails the current one, so re-reading a
* current-version archive is a pure no-op. Writes persist immediately.
*
* Corruption is quarantined, never overwritten: a missing archive is an empty
* one (first run), but an archive that EXISTS and cannot be read or parsed is
* preserved as `<file>.corrupt`, served as an empty read-only view, and every
* subsequent write REFUSES with {@link QuarantinedArchiveError} until an
* operator moves the bad file aside. An archive that reads but declares an
* unsupported schema is rejected loudly instead (a throw from the read path).
*/
var DeviceStore = class {
	#file;
	#devices;
	/**
	* Set when the archive on disk was unreadable and had to be quarantined.
	* While set, {@link #persist} refuses to write — the whole point of the flag
	* is that the bytes on disk are the only remaining copy of the pairings.
	*/
	#quarantine;
	constructor(file) {
		this.#file = file;
	}
	/**
	* Whether the archive has been found unreadable and quarantined.
	*
	* A READ-ONLY PROBE, and deliberately not a `list()`-shaped one. The whole
	* problem it solves is that a quarantined store's empty view is
	* INDISTINGUISHABLE from a genuinely empty one: `list()` returns `[]` either
	* way, so a caller that only looks at the returned array cannot tell "no
	* devices are paired" from "the device list is unknowable". Faces that would
	* otherwise answer with that empty view — every device tool, and the HTTP
	* reads — ask this instead and report the real condition.
	*
	* It consults `#load()` so a store that has never been read still answers
	* truthfully (reading is what DISCOVERS the corruption), and so a store whose
	* archive went bad mid-life is reported as it is NOW rather than as it was at
	* construction. `#load()` cannot throw for this reason: a corrupt archive is
	* quarantined into the empty view rather than propagated.
	*/
	get quarantined() {
		this.#load();
		return this.#quarantine !== void 0;
	}
	/**
	* The quarantine, when there is one: the file, the preservation copy, and the
	* underlying failure. `undefined` for a healthy store.
	*
	* Same read-only contract as {@link quarantined}, for the faces that need to
	* NAME the two files the operator has to look at rather than only report that
	* something is wrong.
	*/
	quarantineInfo() {
		this.#load();
		return this.#quarantine;
	}
	list() {
		return this.#load().map((record) => structuredClone(record));
	}
	resolve(device) {
		const devices = this.list();
		const exact = devices.find((record) => record.deviceId === device);
		if (exact !== void 0) return exact;
		const matches = devices.filter((record) => record.displayName.startsWith(device));
		if (matches.length === 1) return matches[0];
		return { ambiguous: matches.map((record) => record.displayName) };
	}
	upsert(record) {
		const insert = assertValidRecord(record);
		const devices = this.#load().filter((existing) => existing.deviceId !== insert.deviceId);
		devices.push(structuredClone(insert));
		this.#persist(devices);
	}
	remove(deviceId) {
		const devices = this.#load().filter((record) => record.deviceId !== deviceId);
		this.#persist(devices);
	}
	#load() {
		if (this.#devices !== void 0) return this.#devices;
		let archive;
		try {
			archive = readArchive(this.#file);
		} catch (error) {
			if (!(error instanceof QuarantinedArchiveError)) throw error;
			this.#quarantine = error.withCorruptPath(quarantine(error.file));
			console.warn(`device archive ${this.#file} is unreadable and was quarantined; serving an empty read-only archive and refusing all writes until the bad file is moved aside:`, error.cause);
			archive = void 0;
		}
		const devices = archive === void 0 ? [] : archive.devices;
		this.#devices = devices;
		if (archive !== void 0 && archive.schemaVersion < 2) this.#persist(devices);
		return devices;
	}
	#persist(devices) {
		if (this.#quarantine !== void 0) throw this.#quarantine;
		this.#devices = devices;
		persistArchive(this.#file, devices);
	}
};
//#endregion
//#region src/identity.ts
const IDENTITY_FILENAME = "identity.key";
const IDENTITY_MODE = 384;
function identityPath(dataDir) {
	return join(dataDir, IDENTITY_FILENAME);
}
/**
* Parses raw private key bytes through the transport's identity reader.
* Throws when the bytes are not a valid Ed25519 private key.
*/
function parseIdentity(bytes) {
	return {
		key: bytes,
		id: deviceIdentityId(bytes)
	};
}
async function persistIdentity(path, key) {
	await writeFile(path, key, { mode: IDENTITY_MODE });
	await chmod(path, IDENTITY_MODE);
}
/**
* Loads the persistent Ed25519 device identity from `dataDir/identity.key`,
* generating and persisting a new one when the file is missing or corrupt.
*
* The file holds the raw protobuf-encoded private key bytes with 0600
* permissions.
*
* The two failure modes are deliberately NOT treated alike:
*
*  - MISSING (`ENOENT`) is the normal first run: a new identity is generated
*    silently, which is exactly what the caller asked for. ONLY `ENOENT` counts
*    as missing. Every other read failure (EACCES/EISDIR/EIO/…) means bytes are
*    there that this process could not read, and regenerating over them would
*    destroy the only evidence of the previous key — so those take the CORRUPT
*    path below and say so, instead of posing as a quiet first run.
*  - CORRUPT is a data-loss event with a consequence the operator cannot infer
*    from a fresh key alone: the desktop pinned the OLD public key, so every
*    stored pairing is now invalid and will be refused until re-approved. The
*    original bytes are preserved as `<file>.corrupt` and the regeneration is
*    traced on stderr BEFORE it happens, because regenerating silently would
*    destroy the only evidence of what the previous identity was.
*/
async function loadOrCreateIdentity(dataDir) {
	const path = identityPath(dataDir);
	let stored;
	let readError;
	try {
		stored = new Uint8Array(await readFile(path));
	} catch (error) {
		if (error?.code === "ENOENT") return generateIdentity(dataDir, path);
		readError = error;
	}
	try {
		if (stored === void 0) throw readError;
		return parseIdentity(stored);
	} catch (error) {
		const reserved = await quarantineIdentity(path);
		console.error(`[cherry-remote] device identity ${path} is corrupt and could not be parsed (${error instanceof Error ? error.message : String(error)}); it was preserved as ${reserved ?? `${path}.corrupt`} (best effort) and a NEW identity is being generated — every paired device will need re-approval, because the desktop still pins the old public key.`);
		return generateIdentity(dataDir, path);
	}
}
/**
* Copies an unparsable identity file to `<path>.corrupt` so the original bytes
* survive the regeneration. Best effort by design: this runs on the startup
* path, and failing to make a copy must not stop the identity from being
* replaced — the caller reports whatever this returns either way.
*/
async function quarantineIdentity(path) {
	const target = `${path}.corrupt`;
	try {
		await copyFile(path, target);
		await chmod(target, IDENTITY_MODE);
		return target;
	} catch (error) {
		console.warn(`[cherry-remote] identity ${path} could not be preserved as ${target}:`, error);
		return;
	}
}
async function generateIdentity(dataDir, path) {
	const key = await createDeviceIdentity();
	await mkdir(dataDir, { recursive: true });
	await persistIdentity(path, key);
	return parseIdentity(key);
}
//#endregion
//#region src/rpc/jsonRpcClient.ts
/** Default cap on business requests in flight on a single connection. */
const DEFAULT_MAX_IN_FLIGHT = 8;
/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 3e4;
/** Rejection message used once the channel can no longer carry responses. */
const CHANNEL_CLOSED_MESSAGE = "JSON-RPC channel closed";
/** Bounded number of schema issues quoted in one drop warning. */
const ISSUE_LIMIT = 3;
/**
* Longest peer-supplied identifier (`method` / `id`) quoted in a drop warning.
*
* A LOG-SIZE bound, not a protocol one: the frame has already failed validation
* when this applies, so the peer is either broken or hostile, and the log line
* must not grow with whatever it sent.
*/
const FRAME_FIELD_LIMIT = 120;
/**
* The structured error a peer returns for a request. `code` is the literal
* 1000 the transport reserves for protocol failures; `data.reason` is the
* discriminator consumers switch on.
*/
var JsonRpcRequestError = class extends Error {
	code;
	data;
	constructor(code, message, data) {
		super(message);
		this.name = "JsonRpcRequestError";
		this.code = code;
		this.data = data;
		Object.setPrototypeOf(this, new.target.prototype);
	}
};
/** Serialises a frame for the channel; the channel itself carries objects. */
function encodeFrame(value) {
	return JSON.parse(JSON.stringify(value));
}
/**
* Bounded, payload-free description of a dropped frame.
*
* The drop paths fire on frames that FAILED validation, which is exactly the
* set of frames whose contents are least trustworthy — and a peer frame
* carries user content (chat text, tool arguments, file paths). Logging the
* frame itself would therefore publish arbitrary peer-supplied bytes at warn
* level, in a log an operator shares when filing a bug. What an operator
* actually needs is classification: which branch rejected it, the method name
* (a bounded identifier the remote controls, and the only part that routes the
* report), the request id when the frame carries one, and the schema path that
* failed. Everything else stays out.
*
* BOUNDED IN LENGTH TOO, not only in content. `method` and `id` are
* peer-supplied strings, and a hostile or merely broken peer can put a
* megabyte in either: the frame fails validation, and this function then writes
* that megabyte into the operator's log at warn level. Excluding payload fields
* is not enough when the CLASSIFICATION fields are themselves unbounded, so
* both are truncated with an explicit ellipsis (the marker matters — a silently
* clipped value reads as the peer's actual method name, and an operator would
* go looking for a tool that never existed).
*/
function describeFrame(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return `frame is ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`;
	const record = value;
	const parts = [];
	if (typeof record["method"] === "string") parts.push(`method="${bounded(record["method"])}"`);
	if ("id" in record) parts.push(`id=${bounded(JSON.stringify(record["id"]))}`);
	return parts.length === 0 ? "frame has no method or id" : parts.join(" ");
}
/**
* A peer-supplied identifier, clipped to {@link FRAME_FIELD_LIMIT} for logging.
*
* The limit is generous enough to keep every realistic method name and request
* id intact — 120 characters is longer than any name the protocol defines — so
* the clip only ever fires on a frame that is already malformed or hostile.
*/
function bounded(text) {
	return text.length <= FRAME_FIELD_LIMIT ? text : `${text.slice(0, FRAME_FIELD_LIMIT)}…`;
}
/** The zod issue paths of a failed parse, joined for one bounded log line. */
function describeIssues(error) {
	return error.issues.slice(0, ISSUE_LIMIT).map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`).join("; ");
}
/**
* The full, payload-free drop warning: the branch that rejected the frame, its
* classification, and the validation-error path that explains the rejection.
*/
function dropWarning(branch, value, error) {
	return `[cherry-remote] dropped invalid JSON-RPC ${branch} (${describeFrame(value)}): ${describeIssues(error)}`;
}
/**
* JSON-RPC 2.0 client riding on a Noise-encrypted `SecureChannel`.
*
* The published transport package ships only a server, so this layer owns the
* client half: id-keyed request/response correlation, in-flight limits, request
* timeouts, and schema validation in both directions. One instance per
* connection keeps multi-device dispatch isolated by construction.
*/
var JsonRpcClient = class {
	channel;
	/**
	* Current admission cap. Mutable (unlike the other options) because the peer
	* reports its own concurrent-request allowance in `connection.hello`, and the
	* spec's half-the-report rule (§3.4) can only be honoured once that reply has
	* been seen — which is after this client was constructed.
	*/
	maxInFlight;
	defaultTimeoutMs;
	nextId = 0;
	pending = /* @__PURE__ */ new Map();
	handlers = [];
	inFlight = 0;
	queue = [];
	disposed = false;
	reading = false;
	/**
	* Set once the channel is known dead. Kept separate from `disposed` because
	* the two differ in who may still act: a closed channel is terminal for
	* requests, while `disposed` is a deliberate local shutdown.
	*/
	closed = false;
	constructor(channel, opts = {}) {
		this.channel = channel;
		this.maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
		this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.startReadLoop();
	}
	request(method, params, opts) {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("JSON-RPC client disposed"));
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error(CHANNEL_CLOSED_MESSAGE));
		const id = this.nextId;
		this.nextId += 1;
		const envelope = {
			jsonrpc: "2.0",
			id,
			method,
			...params === void 0 ? {} : { params }
		};
		const parsed = jsonRpcRequestSchema.safeParse(envelope);
		if (!parsed.success) return Promise.reject(/* @__PURE__ */ new Error(`Invalid JSON-RPC request for method "${method}"`));
		const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
		return new Promise((resolve, reject) => {
			const send = (abortError) => {
				if (this.disposed || abortError !== void 0) {
					reject(abortError ?? /* @__PURE__ */ new Error("JSON-RPC client disposed"));
					return;
				}
				const timer = setTimeout(() => {
					this.finish(id, `JSON-RPC request "${method}" timed out after ${timeoutMs}ms`);
				}, timeoutMs);
				this.pending.set(id, {
					resolve,
					reject,
					timer
				});
				this.inFlight += 1;
				this.channel.write(encodeFrame(parsed.data)).catch((error) => {
					this.finish(id, error instanceof Error ? error.message : "JSON-RPC write failed");
				});
			};
			if (this.inFlight < this.maxInFlight) send();
			else this.queue.push(send);
		});
	}
	onNotification(handler) {
		this.handlers.push(handler);
	}
	/**
	* Resizes the admission window: `n` is the new cap on requests that may be in
	* flight at once. Only ADMISSIONS are affected — requests already in flight
	* are never cancelled, re-queued, or rejected, because they have already been
	* written to the peer and the peer counts arrivals, not intentions.
	*
	* Shrinking takes effect immediately for new admissions: with more requests
	* in flight than the new cap, the queue simply drains back down to it before
	* anything further is admitted. Growing the window drains the queue at once.
	*
	* The cap is floored at 1: a cap of 0 would queue every request forever with
	* no event that could ever release one, which is a deadlock, not a limit.
	*/
	updateMaxInFlight(n) {
		if (!Number.isFinite(n)) return;
		this.maxInFlight = Math.max(1, Math.floor(n));
		this.drainQueue();
	}
	/**
	* Admits queued requests while the window has room.
	*
	* The bound is re-checked every iteration because `send()` is what increments
	* `inFlight`, and it can also reject without incrementing (disposed or
	* aborted), which must not spin this loop forever.
	*/
	drainQueue() {
		while (this.queue.length > 0 && this.inFlight < this.maxInFlight) {
			const before = this.inFlight;
			this.queue.shift()();
			if (this.inFlight === before) return;
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.failAll("JSON-RPC client disposed");
	}
	/**
	* Tears the client down because its LINK went away, not because the local
	* side chose to stop using it.
	*
	* The distinction is the whole point of a separate entry point. `dispose()`
	* describes this object's own lifetime ("this client was disposed"), which is
	* an internal-sounding statement about the plugin's bookkeeping; a caller
	* holding an in-flight request needs to hear about the DEVICE — the spec §6
	* `{device, state}` condition — and this is the message every layer above
	* already classifies as a dead channel. So the link-loss path fails in flight
	* with {@link CHANNEL_CLOSED_MESSAGE}, exactly as the read loop's own
	* channel-death path does, and marks the client `closed` so a request issued
	* after the loss fails fast with the same face instead of queueing onto a
	* socket that no longer exists.
	*
	* `disposed` is set too — nothing may use this client again — but it is set
	* AFTER the rejection, so the message a caller sees is the link-loss one.
	*/
	disposeForLinkLoss() {
		if (this.disposed) return;
		this.closed = true;
		this.failAll(CHANNEL_CLOSED_MESSAGE);
		this.disposed = true;
	}
	/**
	* Rejects every request that can no longer be answered — both those in flight
	* and those still queued — with one structured error, and clears the queue so
	* no queued request is silently dropped.
	*/
	failAll(message) {
		const error = new Error(message);
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.inFlight = 0;
		const queued = this.queue.splice(0, this.queue.length);
		for (const send of queued) send(error);
	}
	/** Settles one pending request and releases its in-flight slot. */
	finish(id, message) {
		const pending = this.pending.get(id);
		if (pending === void 0) return;
		this.release(id);
		pending.reject(new Error(message));
	}
	resolve(id, value) {
		const pending = this.pending.get(id);
		if (pending === void 0) return;
		this.release(id);
		pending.resolve(value);
	}
	/**
	* Removes bookkeeping for one id and admits the next queued request, but only
	* if the window has room. The room check is not redundant with the one in
	* `request`: the cap can shrink while requests are in flight
	* ({@link updateMaxInFlight}), and an unconditional admit here would let the
	* shrunk window be refilled straight back to the old width.
	*/
	release(id) {
		const pending = this.pending.get(id);
		if (pending === void 0) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		this.inFlight -= 1;
		this.drainQueue();
	}
	/**
	* Drains the channel until it closes. Frames are dispatched in a fixed order:
	* (a) no `id` → notification, (b) `id` + `method` → request, (c) any other
	* `id` frame → response. A frame matching no branch is dropped with a warning
	* so a forward-compatible peer can never crash the client.
	*/
	startReadLoop() {
		if (this.reading) return;
		this.reading = true;
		(async () => {
			for (;;) {
				let frame;
				try {
					frame = await this.channel.read();
				} catch {
					if (!this.disposed) {
						this.closed = true;
						this.failAll(CHANNEL_CLOSED_MESSAGE);
					}
					return;
				}
				if (this.disposed) return;
				try {
					this.dispatch(frame);
				} catch (error) {
					console.warn(`[cherry-remote] dropped unparsable JSON-RPC frame (${error instanceof Error ? error.message : String(error)})`);
				}
			}
		})();
	}
	dispatch(frame) {
		const value = typeof frame === "string" ? JSON.parse(frame) : frame;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			console.warn(`[cherry-remote] dropped non-object JSON-RPC frame (${describeFrame(value)})`);
			return;
		}
		const record = value;
		if (!("id" in record)) {
			const parsed = jsonRpcNotificationSchema.safeParse(value);
			if (!parsed.success) {
				console.warn(dropWarning("notification", value, parsed.error));
				return;
			}
			const { method, params } = parsed.data;
			for (const handler of [...this.handlers]) try {
				handler(method, params);
			} catch (error) {
				console.warn(`[cherry-remote] notification handler for "${method}" threw`, error);
			}
			return;
		}
		if ("method" in record) {
			const parsed = jsonRpcRequestSchema.safeParse(value);
			if (!parsed.success) {
				console.warn(dropWarning("request", value, parsed.error));
				return;
			}
			console.warn(`[cherry-remote] ignoring inbound JSON-RPC request "${parsed.data.method}" (client does not serve requests)`);
			return;
		}
		const parsed = jsonRpcResponseSchema.safeParse(value);
		if (!parsed.success) {
			console.warn(dropWarning("response", value, parsed.error));
			return;
		}
		const response = parsed.data;
		if (!("id" in response) || typeof response.id !== "number") {
			console.warn("[cherry-remote] dropped JSON-RPC response with unknown id");
			return;
		}
		if ("error" in response) {
			const { code, message, data } = response.error;
			const known = data !== null && typeof data === "object" && remoteFailureSchema.safeParse(data).success;
			this.reject(response.id, new JsonRpcRequestError(code, message, known ? data : void 0));
			return;
		}
		this.resolve(response.id, response.result);
	}
	reject(id, error) {
		const pending = this.pending.get(id);
		if (pending === void 0) return;
		this.release(id);
		pending.reject(error);
	}
};
//#endregion
//#region src/rpc/wsAdapter.ts
/**
* Wraps a `ws` library WebSocket in the `RemoteSocket` shape consumed by
* `RemoteSocketStream` from `@cherrystudio/remote-transport`.
*/
function toRemoteSocket(ws) {
	const messageListeners = /* @__PURE__ */ new Set();
	const closeListeners = /* @__PURE__ */ new Set();
	const errorListeners = /* @__PURE__ */ new Set();
	ws.binaryType = "arraybuffer";
	ws.on("message", (data) => {
		for (const listener of [...messageListeners]) listener({ data });
	});
	ws.on("close", () => {
		for (const listener of [...closeListeners]) listener();
	});
	ws.on("error", () => {
		for (const listener of [...errorListeners]) listener();
	});
	return {
		get binaryType() {
			return ws.binaryType;
		},
		set binaryType(type) {
			ws.binaryType = type;
		},
		get bufferedAmount() {
			return ws.bufferedAmount;
		},
		get readyState() {
			return ws.readyState;
		},
		send(data) {
			ws.send(data);
		},
		close(code, reason) {
			ws.close(code, reason);
		},
		addEventListener(type, listener) {
			if (type === "message") messageListeners.add(listener);
			else if (type === "close") closeListeners.add(listener);
			else errorListeners.add(listener);
		},
		removeEventListener(type, listener) {
			if (type === "message") messageListeners.delete(listener);
			else if (type === "close") closeListeners.delete(listener);
			else errorListeners.delete(listener);
		}
	};
}
//#endregion
//#region src/atomicFile.ts
/**
* Crash-durable atomic replacement of one small UTF-8 file.
*
* This is a deliberate REPLICA of `deviceStore.ts`'s `persistArchive` sequence
* (`.tmp` + fsync + chmod 0600 + rename), not a shared helper extracted from it:
* the device archive is an existing subsystem the scope work must not touch
* (spec §3's 永不 non-goal), so the two writers stay independent even though the
* sequence is the same. A future fix to one must be applied to the other.
*
* Why each step is here, in order:
*
*  - `mkdirSync(dirname(file))` — the file's directory is the plugin's own data
*    directory and may not exist on first run; the sequence must not fail there.
*  - `openSync(temp, 'w', mode)` + `writeSync` + `fsyncSync` — the bytes reach
*    the disk before the name switches, so a crash cannot leave a rename that
*    points at unwritten data.
*  - `closeSync` in `finally` — the descriptor is released even if the write or
*    the fsync throws.
*  - `chmodSync(temp, mode)` — `mode` on `open` only applies when the file is
*    CREATED and is masked by the process umask, while `rename` carries the temp
*    file's mode onto the target: chmod'ing the temp explicitly makes both
*    halves of the swap exactly `mode` and re-tightens a pre-existing looser
*    file instead of leaving it as it was.
*  - `renameSync(temp, file)` — the switch itself: a reader sees either the
*    complete old file or the complete new one, never a truncated one. The
*    WHOLE sequence from the `open` that creates the temp to the `rename` that
*    consumes it sits inside ONE cleanup window: any throw in between — the
*    write, the fsync, the close, the chmod, not just the rename — drops the
*    temp file (best effort) so a half-written file is not left for the next
*    reader to trip over, and the original error is what propagates — the
*    target was never touched.
*
* Synchronous by design: the scope document's write path must complete inside
* one uninterruptible critical section (no `await` between validating the
* expected revision and committing the write, spec §6.3).
*/
function writeFileAtomicSync(file, text, mode = 384) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	try {
		const fd = openSync(temp, "w", mode);
		try {
			writeSync(fd, text, void 0, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temp, mode);
		renameSync(temp, file);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}
/**
* The default scope: nobody, write-enabled.
*
* This is what a missing file reads as (first run), and it is also the exact
* shape every unreadable/invalid document falls back to. It carries NO
* `updatedAt` key — the absence is load-bearing, because assertion ① compares
* a fresh state's document to this constant with a deep-equality check.
*/
const DEFAULT_SCOPE = {
	version: 1,
	revision: 0,
	mode: "selected",
	workspaceIds: []
};
/** The id comparison contract: `String(value).trim()`, on both sides. */
function normalizeWorkspaceId(value) {
	return String(value).trim();
}
/**
* Boundary normalization of one registry item.
*
* The registry's return type is not ours to assume (its ids are not guaranteed
* to be strings), so every text field goes through `String(...)`: an item with
* no usable id or path is `undefined` and is dropped by the caller, while
* `sessionIds` that is not an array degrades to `[]` rather than throwing.
*/
function toScopeWorkspace(raw) {
	if (!isRecord$2(raw)) return void 0;
	const id = usableText(raw.id);
	if (id === void 0) return void 0;
	const path = usableText(raw.path);
	if (path === void 0) return void 0;
	return {
		id,
		title: raw.title === void 0 || raw.title === null ? "" : String(raw.title),
		path,
		sessionIds: Array.isArray(raw.sessionIds) ? raw.sessionIds.map((value) => String(value)) : []
	};
}
/**
* The visibility strictness order (B9), and the single implementation of it that
* the visibility layer, diagnostics, the settings page and the tests share.
*
* `global` is visible for any id — including `undefined`, which is why a
* `global` document never installs a deny layer even when no judgement exists.
* `selected` is fail-closed: a hit is visible, and a miss, `undefined`, or an
* empty list is not. Both sides of the comparison are normalized through
* {@link normalizeWorkspaceId} first; normalizing still unequal means "not a
* match" — no case folding and no path-level guessing.
*/
function isVisible(doc, workspaceId) {
	if (doc.mode === "global") return true;
	if (workspaceId === void 0) return false;
	const wanted = normalizeWorkspaceId(workspaceId);
	return doc.workspaceIds.some((id) => normalizeWorkspaceId(id) === wanted);
}
/**
* One judgement record.
*
* `visible` is computed in exactly this one place, from {@link isVisible} alone
* — never from `status`, and never from the list's health or the presence of a
* `cwd`. The optional fields are OMITTED when absent rather than set to
* `undefined`, so `Object.hasOwn` still tells "there is no workspace" from
* "there is one".
*/
function judged(doc, agent, status, workspaceId, reason) {
	return {
		agentId: agent.id,
		status,
		...workspaceId === void 0 ? {} : { workspaceId },
		visible: isVisible(doc, workspaceId),
		reason,
		...agent.cwd === void 0 ? {} : { cwd: agent.cwd }
	};
}
/**
* A workspace as a `reason` fragment: the title when the registry supplied one,
* and always the id. Task 5 writes this reason into the installed-layer record
* and `guard` echoes it back, so it has to name a workspace a reader can resolve
* — the tuple is what makes that true for a titleless item (B6).
*/
function describeWorkspace(workspace) {
	return workspace.title === "" ? `工作区 ${workspace.id}` : `工作区「${workspace.title}」(${workspace.id})`;
}
/**
* The one "input → normalized document" entry point; both `load()` and `save()`
* go through it, so the document shape exists in exactly one place.
*
* `input` is either the text read from disk or an already-parsed value.
*  - unparsable text, a type-invalid `version` (missing / non-numeric / a
*    string), or any other invalid field ⇒ `problem: 'parse'` and the STRICT
*    side (`selected` + empty): the caller warns through the existing carrier
*    and the document stays writable (B9);
*  - a type-legal `version` other than {@link SCOPE_DOC_VERSION} ⇒
*    `problem: 'version-unsupported'`, the same strict side, and a read-only
*    degradation the caller records (never a silent "the user selected
*    nothing"). That branch is decided by `version` ALONE, before the remaining
*    field checks: a newer format plausibly carries fields this build cannot
*    parse, and letting that combination read as a parse failure would hand a
*    newer document back as WRITABLE — the exact opposite of the latch's
*    purpose;
*  - otherwise the normalized document, with `workspaceIds` de-duplicated and
*    stably sorted ascending by string comparison. The stored literals are
*    never rewritten — comparison normalization is `isVisible`'s job.
*
* `parseScopeDoc` deliberately does not exist as a separate export: this is the
* only entry, module-internal helpers included.
*/
function normalizeScope(input) {
	const parsed = parseScopeInput(input);
	if (!parsed.ok) return {
		doc: strictScope(),
		problem: "parse"
	};
	const value = parsed.value;
	if (!isRecord$2(value)) return {
		doc: strictScope(),
		problem: "parse"
	};
	const { version, revision } = value;
	if (!isFiniteNumber(version)) return {
		doc: strictScope(),
		problem: "parse"
	};
	if (version !== 1) return {
		doc: strictScope(),
		problem: "version-unsupported"
	};
	if (!isFiniteNumber(revision)) return {
		doc: strictScope(),
		problem: "parse"
	};
	const fields = readScopeFields(value);
	if (fields === void 0) return {
		doc: strictScope(),
		problem: "parse"
	};
	const updatedAt = value.updatedAt;
	if (updatedAt !== void 0 && typeof updatedAt !== "string") return {
		doc: strictScope(),
		problem: "parse"
	};
	return { doc: updatedAt === void 0 ? {
		version,
		revision,
		mode: fields.mode,
		workspaceIds: fields.workspaceIds
	} : {
		version,
		revision,
		updatedAt,
		mode: fields.mode,
		workspaceIds: fields.workspaceIds
	} };
}
/** A fresh strict-side document (never the shared `DEFAULT_SCOPE` object). */
function strictScope() {
	return {
		version: 1,
		revision: 0,
		mode: "selected",
		workspaceIds: []
	};
}
/** `JSON.parse` for text input; any other value is taken as already parsed. */
function parseScopeInput(input) {
	if (typeof input !== "string") return {
		ok: true,
		value: input
	};
	try {
		return {
			ok: true,
			value: JSON.parse(input)
		};
	} catch {
		return { ok: false };
	}
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
/** `String(value).trim()`, or `undefined` when there is nothing usable. */
function usableText(value) {
	if (value === void 0 || value === null) return void 0;
	const text = String(value).trim();
	return text === "" ? void 0 : text;
}
/**
* The field-and-type validation shared by the PUT body and the document: `mode`
* must be one of the two modes and `workspaceIds` must be an array of strings.
* Registry-outside ids are NOT a validation failure — pruning is their ruling
* (B14). The returned ids are de-duplicated and sorted.
*/
function readScopeFields(value) {
	if (!isRecord$2(value)) return void 0;
	const mode = value.mode;
	if (mode !== "global" && mode !== "selected") return void 0;
	const raw = value.workspaceIds;
	if (!Array.isArray(raw)) return void 0;
	const ids = [];
	for (const id of raw) {
		if (typeof id !== "string") return void 0;
		ids.push(id);
	}
	return {
		mode,
		workspaceIds: [...new Set(ids)].sort()
	};
}
/** The on-disk form, matching the shape the rest of the repo writes. */
function serializeScope(doc) {
	return `${JSON.stringify(doc, null, 2)}\n`;
}
/**
* In-memory authority over the scope document.
*
* A missing file is the default scope (D3) and is SILENT — no warn, no note.
* Anything else unreadable lands on the strict side with one warn. The document
* is read at most once per state (`load()` is idempotent), and every read
* accessor loads lazily, so a caller cannot observe a half-initialized state.
*
* The workspace list has exactly three states, fixed by the shape of
* `setWorkspaces`' argument: 未读 (never called — the initial state, written by
* nobody), 读成功 (a non-empty array), 读失败 (`undefined` OR an empty array).
* `[]` counting as read failure is the point of B16: reading an empty registry
* as "every id is gone" would silently prune the user's whole selection.
* `setWorkspaces` is the ONLY production writer, and it holds the only write
* site of the `workspace-list` note in this codebase (added when a read fails,
* dropped again when one succeeds — the note is state, not history, R8).
*
* From Task 3 on this class also owns the judgement: `rebuild()` is the only
* asynchronous method here and the only caller of `setWorkspaces`; it builds one
* whole generation — the canonical path map, the per-agent judgements and the
* `pathUnmatched` diagnostics — and swaps it in at once, while `judgement()` and
* `pathUnmatched()` are synchronous reads of that generation.
*/
var ToolScopeState = class {
	#file;
	#log;
	#loaded = false;
	#doc = strictScope();
	/** Set when the on-disk document declared a version this build cannot use. */
	#versionUnsupported = false;
	/** Same source ⇒ one entry, latest reason; different sources coexist. */
	#degraded = /* @__PURE__ */ new Map();
	#host = {
		state: "pending",
		capable: false,
		reason: "等待宿主注入 agents / workspaceRegistry"
	};
	#listState = "unread";
	#workspaces = [];
	/** Per-agent installed layers: the execution-side mirror `guard` reads. */
	#layers = /* @__PURE__ */ new Map();
	/** The current generation's canonical path map: entity path ⇒ workspaceId. */
	#pathMap = /* @__PURE__ */ new Map();
	/** The current generation's per-agent judgements. `rebuild()` replaces it whole. */
	#judgements = /* @__PURE__ */ new Map();
	/** cwd samples that resolved outside the registry: diagnostics, NOT degraded. */
	#pathUnmatched = [];
	constructor(options) {
		this.#file = options.file;
		this.#log = options.log;
	}
	/** Reads the document once. Idempotent, and never throws (B9). */
	load() {
		this.#ensureLoaded();
	}
	/** The current document. The returned object IS the authoritative one. */
	doc() {
		this.#ensureLoaded();
		return this.#doc;
	}
	/** The degradation notes, one per source; `[]` means no degradation. */
	degraded() {
		this.#ensureLoaded();
		return [...this.#degraded.values()];
	}
	/** Records a note: same source replaces the reason, other sources survive. */
	noteDegraded(note) {
		this.#degraded.set(note.source, {
			source: note.source,
			reason: note.reason
		});
	}
	/** The host capability tri-state, as written by the host integration layer.
	* Returned as a COPY under a `Readonly` type: `setHost` is its only writer. */
	host() {
		return { ...this.#host };
	}
	setHost(next) {
		this.#host = next;
	}
	/**
	* The workspace list's single write site.
	*
	* A non-empty array is an authoritative read (reconcile and prune, and the
	* `workspace-list` note is dropped here because a later read succeeded);
	* `undefined` or `[]` is a read FAILURE — the list becomes unavailable, the
	* judgement goes fail-closed for `selected`, the write side is refused (503)
	* and the `workspace-list` note is recorded right here, once, and nowhere
	* else.
	*/
	setWorkspaces(list) {
		if (list === void 0 || list.length === 0) {
			this.#listState = "unavailable";
			this.#workspaces = [];
			this.noteDegraded({
				source: "workspace-list",
				reason: "工作区列表不可用（注册表读取失败或返回空表）；判定 fail-closed，写侧拒绝"
			});
			return;
		}
		this.#listState = "read";
		this.#clearDegraded("workspace-list");
		this.#workspaces = list.map((raw) => toScopeWorkspace(raw)).filter((workspace) => workspace !== void 0);
	}
	/**
	* The normalized registry list; `[]` for both 未读 and 读失败.
	*
	* A DETACHED copy (`readonly` on the outside, fresh objects inside), like the
	* sibling reader `degraded()`: the live generation may only be changed by its
	* own writers (`setWorkspaces`, `rebuild`), never by a caller that happens to
	* hold the array.
	*/
	workspaces() {
		return this.#workspaces.map((workspace) => ({
			...workspace,
			sessionIds: [...workspace.sessionIds]
		}));
	}
	/**
	* Document ids the registry no longer has (B14), for the settings page.
	*
	* `[]` for 未读 and for 读失败 as well as for a clean document: "cannot read
	* the list" must never be presented as "every id is stale".
	*/
	staleWorkspaceIds() {
		this.#ensureLoaded();
		if (this.#listState !== "read") return [];
		const known = this.#knownWorkspaceIds();
		return this.#doc.workspaceIds.filter((id) => !known.has(normalizeWorkspaceId(id)));
	}
	/**
	* Recomputes ONE generation — the canonical path map, the per-agent judgement
	* cache and the `pathUnmatched` diagnostics — and swaps it in with a single
	* assignment. The only asynchronous method on this class.
	*
	* The build order is fixed: the list first (`setWorkspaces` is its only
	* production writer, `[]` counting as a read failure exactly as `undefined`
	* does), then the map keyed on each item's ENTITY path, then one judgement per
	* agent. Everything the readers see is built into locals, so a rebuild still
	* awaiting `resolveByPath` leaves them on the PREVIOUS generation instead of
	* exposing a half-built map.
	*/
	async rebuild(registry, agents) {
		this.#ensureLoaded();
		const doc = this.#doc;
		let listed;
		let listAvailable = false;
		try {
			const raw = registry.list();
			if (Array.isArray(raw) && raw.length > 0) {
				listed = raw;
				listAvailable = true;
			}
		} catch (error) {
			this.#warn("工作区注册表 list() 抛出，按 B16 视为列表不可用（判定 fail-closed，写侧拒绝）", error);
		}
		this.setWorkspaces(listed);
		const workspaces = this.#workspaces;
		const pathMap = /* @__PURE__ */ new Map();
		const resolveByPath = registry.resolveByPath;
		if (typeof resolveByPath === "function") for (const workspace of workspaces) {
			let entity;
			try {
				entity = await resolveByPath.call(registry, workspace.path);
			} catch (error) {
				this.#warn(`工作区注册表项 ${workspace.path} 的路径解析失败（resolveByPath reject）；本轮跳过该项，其余项与全部 agent 的判定不受影响`, error);
				continue;
			}
			const resolved = entity === void 0 ? void 0 : toScopeWorkspace(entity);
			if (resolved === void 0) continue;
			pathMap.set(resolved.path, resolved.id);
		}
		else {
			this.noteDegraded({
				source: "path-normalization",
				reason: "宿主无 resolveByPath，路径匹配退化为大小写敏感字符串等价（不做 realpath）；符号链接或拼写差异下规则二可能不命中，此时只剩 sessionIds 一条路"
			});
			for (const workspace of workspaces) pathMap.set(workspace.path, workspace.id);
		}
		const judgements = /* @__PURE__ */ new Map();
		const pathUnmatched = [];
		for (const agent of agents) {
			const judgement = await this.#judge(doc, workspaces, agent, registry, pathMap, listAvailable);
			judgements.set(agent.id, judgement);
			if (judgement.status === "no-match" && judgement.cwd !== void 0) pathUnmatched.push({
				agentId: judgement.agentId,
				cwd: judgement.cwd
			});
		}
		this.#pathMap = pathMap;
		this.#judgements = judgements;
		this.#pathUnmatched = pathUnmatched;
		let resolved = 0;
		let unresolved = 0;
		for (const judgement of judgements.values()) if (judgement.status === "resolved") resolved += 1;
		else if (judgement.status === "unresolved") unresolved += 1;
		return {
			listAvailable,
			agents: agents.length,
			resolved,
			unresolved,
			pathUnmatched: pathUnmatched.length
		};
	}
	/** The current generation's judgement for one agent, or a cache miss. */
	judgement(agentId) {
		return this.#judgements.get(agentId);
	}
	/**
	* The same two §4 rules as `#judge`, answered from the CURRENT generation
	* without awaiting anything — the synchronous window's fallback when
	* `judgement()` misses.
	*
	* `undefined` means "there is no usable generation": the caller keeps today's
	* fail-closed behaviour. That is NOT the same as a resolution that concluded
	* "no workspace belongs to this agent".
	*
	* PURE READ (D14): no `#ensureLoaded()`, no write to `#judgements`, no await
	* and no host call — the synchronous window reads the cache and never blocks.
	* A read that was never taken, or that failed / returned an empty table, has
	* no generation to read: `'unread'` and `'unavailable'` both mean exactly that.
	* One consequence: this window cannot await a `resolveByPath` realpath, so a
	* `cwd` that would match only AFTER one is concluded `no-match` here, and the
	* asynchronous round is what corrects it.
	*/
	resolveNow(agent) {
		if (this.#listState !== "read") return void 0;
		const doc = this.#doc;
		const member = this.#workspaces.find((workspace) => workspace.sessionIds.includes(agent.id));
		if (member !== void 0) return judged(doc, agent, "resolved", member.id, `会话成员命中 ${describeWorkspace(member)}`);
		if (agent.cwd === void 0) return judged(doc, agent, "no-cwd", void 0, "会话 header 无 cwd，路径规则无法判定（D7：仅 selected 下不可见；该状态不启动复检）");
		const workspaceId = this.#pathMap.get(agent.cwd);
		return workspaceId === void 0 ? judged(doc, agent, "no-match", void 0, `cwd ${agent.cwd} 在本窗口的规范路径表里没有匹配项（本窗口可能尚无路径表——invalidateDerived() 之后它是空的，重建期间它还是上一代的——也无法 await resolveByPath 的 realpath；异步轮次会给出权威判定）`) : judged(doc, agent, "resolved", workspaceId, `规范化路径命中 ${this.#label(this.#workspaces, workspaceId)}`);
	}
	/**
	* Agents whose `cwd` resolved outside every registered workspace, with the
	* `cwd` sample (§6.1's 路径不匹配诊断). Diagnostics only — no `degraded` entry
	* carries this, so "勾了却无工具" can be told apart from a degraded read.
	*/
	pathUnmatched() {
		return this.#pathUnmatched;
	}
	/**
	* Validates and commits one write, synchronously (no `await` anywhere in the
	* critical section, §6.3).
	*
	* The refusal priority is FIXED: an unsupported document version (503) > an
	* unavailable workspace list (503) > invalid request fields (400) > a missing
	* base revision (400) > a revision conflict (409). Pre-existing state
	* outranks request-body validation — a newer document plus a malformed body
	* must report the newer document, never `invalid-scope`.
	*
	* On success the pruned ids are dropped (only under an authoritative list —
	* never while 未读 or 读失败), the revision is bumped by exactly one, the
	* normalized document is written atomically as 0600, and the in-memory
	* authority holds THAT document: the returned `doc` is the same object
	* `doc()` serves.
	*/
	save(body, expectedRevision) {
		this.#ensureLoaded();
		if (this.#versionUnsupported) return {
			ok: false,
			status: 503,
			error: "scope-version-unsupported",
			message: "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）：本插件支持 version 1，文档版本高于本插件支持或低于本插件支持，不能覆写该文档；已存内容一位不动"
		};
		if (this.#listState === "unavailable") return {
			ok: false,
			status: 503,
			error: "workspace-list-unavailable",
			message: "工作区列表不可用，无法替用户做写决策；已存内容一位不动"
		};
		const fields = readScopeFields(body);
		if (fields === void 0) return {
			ok: false,
			status: 400,
			error: "invalid-scope",
			message: "mode 必须是 global 或 selected，workspaceIds 必须是字符串数组"
		};
		if (!isFiniteNumber(expectedRevision)) return {
			ok: false,
			status: 400,
			error: "missing-expected-revision",
			message: "请求必须携带基准 expectedRevision（读-改-写）"
		};
		const current = this.#doc.revision;
		if (expectedRevision !== current) return {
			ok: false,
			status: 409,
			error: "scope-revision-conflict",
			message: `配置已被他处修改（当前 revision=${current}），请重新读取后再保存`
		};
		const known = this.#listState === "read" ? this.#knownWorkspaceIds() : void 0;
		const pruned = [];
		const kept = [];
		for (const id of fields.workspaceIds) if (known !== void 0 && !known.has(normalizeWorkspaceId(id))) pruned.push(id);
		else kept.push(id);
		const { doc } = normalizeScope({
			version: 1,
			revision: current + 1,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			mode: fields.mode,
			workspaceIds: kept
		});
		writeFileAtomicSync(this.#file, serializeScope(doc));
		this.#doc = doc;
		return {
			ok: true,
			doc,
			pruned
		};
	}
	/** The installed layer for one agent, or `undefined` when none is mounted. */
	layer(agentId) {
		return this.#layers.get(agentId);
	}
	/** Records the layer installed for one agent (the record IS the mirror). */
	setLayer(agentId, layer) {
		this.#layers.set(agentId, layer);
	}
	/** Forgets one agent's layer, in the same turn its restriction is released. */
	clearLayer(agentId) {
		this.#layers.delete(agentId);
	}
	/**
	* Drops everything derived from a previous mount: the installed-layer records
	* and the whole judgement generation — the canonical path map, the per-agent
	* judgements and the `pathUnmatched` diagnostics (Task 4's teardown asserts
	* exactly this).
	*
	* N1: the workspace LIST is part of that generation, so `#listState` and
	* `#workspaces` are reset with it. Keeping the previous mount's list made
	* 「no usable generation」 false for {@link resolveNow}: a re-mounted
	* generation's FIRST synchronous pass runs before its own round has read
	* anything, so it would answer §4's rule one from the OLD registry and
	* RELEASE a layer instead of denying — and `GET /scope` would serve that list
	* until the round landed.
	*
	* `'unread'` and not `'unavailable'` on purpose: nothing FAILED here, so no
	* `workspace-list` note is recorded, and `save()` keeps the never-read
	* behaviour (a write is accepted and prunes NOTHING — an invalidated list is
	* no more authoritative than one never read). `staleWorkspaceIds()` answers
	* `[]` for the same reason.
	*/
	invalidateDerived() {
		this.#layers.clear();
		this.#pathMap = /* @__PURE__ */ new Map();
		this.#judgements = /* @__PURE__ */ new Map();
		this.#pathUnmatched = [];
		this.#listState = "unread";
		this.#workspaces = [];
	}
	/**
	* One agent's judgement against the generation being built, following §4's
	* two rules in order: the header-validated `sessionIds` projection wins, and
	* the canonical path map is the only path comparison there is.
	*
	* `doc` and `workspaces` are the snapshots `rebuild()` took for this whole
	* round, so two agents of one generation can never be judged against two
	* different documents or lists.
	*/
	async #judge(doc, workspaces, agent, registry, pathMap, listAvailable) {
		const member = workspaces.find((workspace) => workspace.sessionIds.includes(agent.id));
		if (member !== void 0) return judged(doc, agent, "resolved", member.id, `会话成员命中 ${describeWorkspace(member)}`);
		if (agent.cwd === void 0) return judged(doc, agent, "no-cwd", void 0, "会话 header 无 cwd，路径规则无法判定（D7：仅 selected 下不可见；该状态不启动复检）");
		if (!listAvailable) return judged(doc, agent, "unresolved", void 0, `工作区列表不可用，cwd ${agent.cwd} 本次无法解析（D14 的有界复检只对该状态启动）`);
		const resolveByPath = registry.resolveByPath;
		if (typeof resolveByPath !== "function") {
			const workspaceId = pathMap.get(agent.cwd);
			return workspaceId === void 0 ? judged(doc, agent, "no-match", void 0, `宿主无 resolveByPath，cwd ${agent.cwd} 与任何注册表项都不大小写敏感相等（D7：无工作区）`) : judged(doc, agent, "resolved", workspaceId, `路径字符串等价命中 ${this.#label(workspaces, workspaceId)}`);
		}
		let entity;
		try {
			entity = await resolveByPath.call(registry, agent.cwd);
		} catch (error) {
			this.#warn(`cwd ${agent.cwd} 的 resolveByPath 调用失败；判定为 unresolved（D14 的有界复检只对该状态启动）`, error);
			return judged(doc, agent, "unresolved", void 0, `cwd ${agent.cwd} 本次解析失败（注册表未就绪或 realpath 失败）`);
		}
		if (entity === void 0) return judged(doc, agent, "no-match", void 0, `宿主不拥有目录 ${agent.cwd}（resolveByPath 返回 undefined），不属任何已注册工作区（D7）`);
		const resolved = toScopeWorkspace(entity);
		const workspaceId = resolved === void 0 ? void 0 : pathMap.get(resolved.path);
		if (workspaceId === void 0) return judged(doc, agent, "no-match", void 0, `cwd ${agent.cwd} 解析成功但不属任何已注册工作区（D7）`);
		return judged(doc, agent, "resolved", workspaceId, `规范化路径命中 ${this.#label(workspaces, workspaceId)}`);
	}
	/** The workspace id, plus its title when this generation's list carries one. */
	#label(workspaces, workspaceId) {
		const workspace = workspaces.find((item) => item.id === workspaceId);
		return workspace === void 0 ? `工作区 ${workspaceId}` : describeWorkspace(workspace);
	}
	/**
	* The removal half of the note set. `degraded` is STATE, not history (R8):
	* the `workspace-list` note must not outlive the read failure that produced
	* it, or one transient registry failure would keep Task 8's save button
	* disabled for the rest of the process while `save()` itself accepts the very
	* same `PUT` (it refuses only while the list is CURRENTLY unavailable).
	*
	* Module-private on purpose: the method list is a contract for Tasks 4–9, and
	* `setWorkspaces` is the only place allowed to add OR drop this source. The
	* other four sources stay append-only — none of them has a success trigger.
	*/
	#clearDegraded(source) {
		this.#degraded.delete(source);
	}
	#knownWorkspaceIds() {
		return new Set(this.#workspaces.map((workspace) => normalizeWorkspaceId(workspace.id)));
	}
	/**
	* The one read of the file, and the one place the strictness order is applied
	* to disk content:
	*  - ENOENT ⇒ the default scope, silently (first run, D3);
	*  - another read error ⇒ the strict side + one warn;
	*  - an unsupported version ⇒ the strict side + the `scope-version` note and a
	*    latch that refuses every write;
	*  - a parse failure / invalid field ⇒ the strict side + one warn, writable.
	*/
	#ensureLoaded() {
		if (this.#loaded) return;
		this.#loaded = true;
		let text;
		try {
			text = readFileSync(this.#file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			this.#warn(`作用域文档 ${this.#file} 读取失败；按 B9 落到更严一侧（selected + 空列表），写入仍可覆盖`, error);
			return;
		}
		const { doc, problem } = normalizeScope(text);
		this.#doc = doc;
		if (problem === "parse") {
			this.#warn(`作用域文档 ${this.#file} 解析失败或字段非法；按 B9 落到更严一侧（selected + 空列表），写入仍可覆盖`);
			return;
		}
		if (problem === "version-unsupported") {
			this.#versionUnsupported = true;
			this.noteDegraded({
				source: "scope-version",
				reason: "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）：本插件支持 version 1，文档版本高于本插件支持或低于本插件支持；已只读降级并拒绝写入，避免覆写不同格式的文档"
			});
		}
	}
	/** The existing warn channel: the injected `log`, else `console.warn`. */
	#warn(message, error) {
		if (this.#log !== void 0) {
			this.#log(message, error);
			return;
		}
		console.warn(message, error);
	}
};
//#endregion
//#region src/diagnostics.ts
/**
* The six differences, in the order the spec's §7-3 list names them.
*
* Adding a seventh entry here is a TWO-line change (this table plus the
* checklist document); the behavioural work of a new difference belongs in the
* fake and in a new assertion, and the tests will fail until both land.
*/
const CONTRACT_DIFFERENCES = [
	{
		id: "connection-closed-not-sent",
		title: "connection.closed is never sent by the real peer",
		realPeer: "The desktop terminates a session with the SOCKET close code (1000/1011/1013) and never emits a `connection.closed` notification. The frame exists in the schema as a notification shape only: it is absent from connectionMethods/pairingMethods, so no request face produces it.",
		fakePeer: "The fake exposes `pushNotification(\"connection.closed\", ...)` so a client that must TOLERATE the schema-valid frame can be exercised; it never fabricates one on its own.",
		schemaAnchor: "connectionNotificationSchema (@cherrystudio/remote-protocol)",
		checklistStep: "connection-closed-not-sent: with a real desktop connected, force a link drop (disable the desktop's Wi-Fi or quit Cherry Studio) and confirm the plugin logs a socket-close/reconnect path and NOTHING resembling a received `connection.closed` notification."
	},
	{
		id: "approval-card-not-realtime",
		title: "Approval cards are not delivered in real time by the real stream",
		realPeer: "An approval/question card is persisted and is read back through `agent.interactions.list`; it is NOT pushed in real time over the `agent.events` stream the way this fake pushes it, so the list query is the authoritative source and the in-stream event is a bonus.",
		fakePeer: "The fake pushes `interaction.updated` in-stream (`pushInteractionOnRun`) AND serves the same card from `agent.interactions.list`, so both client paths are exercisable.",
		schemaAnchor: "agentNotificationSchema + agentMethods[\"agent.interactions.list\"]",
		checklistStep: "approval-card-not-realtime: trigger a tool call on the real desktop that raises an approval card; confirm `cherry_interactions` finds it through `agent.interactions.list` even when no `interaction.updated` event arrived, and that `cherry_respond` still accepts the listed snapshot."
	},
	{
		id: "rate-limit-terminates-session",
		title: "Over-limit rate limiting terminates the whole session (close 1011)",
		realPeer: "Exceeding the desktop's per-socket budget (64 req/s in the current implementation, a server value with no negotiation channel) terminates the ENTIRE session with close code 1011 — it is not a per-request `RATE_LIMITED` rejection the caller can retry in place.",
		fakePeer: "The fake closes the session with 1011 once `rateLimitPerSecond` is exceeded, so the client's offline→backoff→reconnect path is exercised rather than a request-level refusal.",
		schemaAnchor: "remoteLimits + peer close code 1011 (implementation value, not a protocol promise)",
		checklistStep: "rate-limit-terminates-session: against a real desktop, drive a burst well above the smooth budget and confirm the socket is closed with 1011 (session gone, state offline, backoff restart) rather than a single structured per-request rejection."
	},
	{
		id: "execution-terminal-no-interrupted",
		title: "The real agent journal never produces an `interrupted` execution terminal",
		realPeer: "agentJournal settles an execution on `completed` | `failed` | `cancelled` only. The schema already admits `interrupted`, so the client must handle it, but the current server never emits it for an execution.",
		fakePeer: "The fake injects a schema-valid `interrupted` terminal through `runTerminalStatus` (Task 9⑭) so the client's waiter is proven to converge on it instead of hanging to its timeout.",
		schemaAnchor: "executionSchema (@cherrystudio/remote-protocol/agent)",
		checklistStep: "execution-terminal-no-interrupted: run several real turns (including a cancelled one) and confirm every observed `execution.updated` terminal is completed/failed/cancelled; treat any `interrupted` as a protocol change worth reporting, not as expected noise."
	},
	{
		id: "command-receipt-can-be-interrupted",
		title: "A command receipt status may be `interrupted` (a different dimension)",
		realPeer: "The command receipt's `status` enum is accepted|applied|rejected|interrupted: `interrupted` means the command's OUTCOME IS UNDETERMINED. That is a separate axis from the execution terminal set, and a caller must not fold the two together.",
		fakePeer: "The fake records and replays receipts verbatim through its idempotency ledger, so any schema-valid receipt status — including `interrupted` — round-trips unchanged.",
		schemaAnchor: "commandReceiptSchema (@cherrystudio/remote-protocol/agent)",
		checklistStep: "command-receipt-can-be-interrupted: after a send the plugin reports as undetermined, query the command (or re-issue the same commandId) and confirm an `interrupted` receipt is passed through as an undetermined outcome, NOT reported as a finished run."
	},
	{
		id: "resource-exhausted-receipt-cap",
		title: "RESOURCE_EXHAUSTED on the receipt dimension is a rejected receipt, not a dead link",
		realPeer: "When the peer's command/receipt capacity is exhausted the command comes back as a REJECTED RECEIPT carrying `error.reason: \"RESOURCE_EXHAUSTED\"` while the session stays healthy. (The SUBSCRIPTION dimension, `agent.sessions.subscribe` beyond the cap, is a different injection anchored by Task 7⑨.)",
		fakePeer: "The fake answers `sendOutcome: \"resource-exhausted\"` with that exact rejected receipt, leaving the socket up so a client that mistakes it for a transport failure is caught.",
		schemaAnchor: "commandReceiptSchema.error.reason includes RESOURCE_EXHAUSTED",
		checklistStep: "resource-exhausted-receipt-cap: force the real desktop into receipt exhaustion (repeat commands until it refuses) and confirm the plugin surfaces a structured rejected receipt with `RESOURCE_EXHAUSTED`, keeps the connection up, and does not crash."
	}
];
/**
* B7①'s upgrade hint, as the diagnostics face states it.
*
* Terse because this is a developer surface, and a server-side literal because
* the settings panel's copy lives in another bundle (see
* {@link DiagnosticsScopeReport.upgradeHint}). It is only ever attached to an
* `unsupported` host.
*/
const SCOPE_UPGRADE_HINT = "请升级宿主 / DSH 以获得该能力后再试；升级前本插件不会注册这些工具。";
/**
* Attaches B7①'s hint to the REPORT's scope segment.
*
* Deliberately not done in {@link readScopeSegment} or {@link projectScope}:
* both also build `GET /cherry-remote/api/scope`'s body, whose `host` spec §6.3
* fixes at four fields (see {@link DiagnosticsScopeReport}). The hint is derived
* from the state it explains, so a hand-stuffed input cannot smuggle its own.
*/
function reportScope(segment) {
	return {
		...segment,
		upgradeHint: segment.host.state === "unsupported" ? SCOPE_UPGRADE_HINT : ""
	};
}
/**
* The host projection, and the ONE place `capable` is decided.
*
* `capable` is deliberately not carried alongside `state`: the spec defines it
* as nothing but the boolean projection of the tri-state (「`capable` 仅是
* `state === 'ready'` 的布尔投影」), so it is derived here instead of copied
* from a second field that could contradict it. Every state the plugin's own
* host layer writes is already consistent, so this is the identity in practice —
* and for a hand-stuffed input it is what makes assertion ① hold unconditionally.
*/
function projectHostFace(host, degraded) {
	return {
		state: host.state,
		capable: host.state === "ready",
		reason: host.reason,
		degraded: degraded.map((note) => ({
			source: note.source,
			reason: note.reason
		}))
	};
}
/**
* THE one read of the scope state (Task 9 ②).
*
* Two faces call this and only this: `src/httpApi.ts`'s `GET /scope` handler
* takes its `host` and `pathUnmatched` out of the returned segment, and the
* diagnostics source hands the very same call to {@link buildDiagnostics}.
* There is deliberately no second projection anywhere — a copy built while the
* assembly is wired would freeze the capability tri-state at whatever it was
* during `apply()`, which is exactly the stale second copy assertion ② forbids.
*
* Read-only in both directions: `workspaceIds`, the degraded notes and the
* unmatched-cwd entries are copied out, never aliased to the live state.
*/
function readScopeSegment(scope) {
	const doc = scope.doc();
	return {
		mode: doc.mode,
		revision: doc.revision,
		workspaceIds: [...doc.workspaceIds],
		host: projectHostFace(scope.host(), scope.degraded()),
		pathUnmatched: scope.pathUnmatched().map((entry) => ({
			agentId: entry.agentId,
			cwd: entry.cwd
		}))
	};
}
/** The marker appended when a message was cut, so a reader knows it is partial. */
const ERROR_MESSAGE_ELLIPSIS = "…[truncated]";
/**
* Bounds one error message, KEEPING the ellipsis inside the cap.
*
* Exported because it is the unit the contract suite asserts directly: given a
* 10 000-character message it must return something at most
* {@link ERROR_MESSAGE_MAX} characters long that still starts with the original
* head, so an operator keeps the discriminating part of the reason.
*/
function truncateErrorMessage(message) {
	if (message.length <= 200) return message;
	return `${message.slice(0, 188)}${ERROR_MESSAGE_ELLIPSIS}`;
}
/**
* The 12-hex digest that stands in for a raw pinned identity, or `'unknown'`
* when there is no identity to stand in for.
*
* The empty guard is not cosmetic: sha256('') is a FIXED, perfectly
* well-formed 12-hex string, so digesting an absent identity would publish
* something an operator reads as a real (if unusual) pin — and every
* identity-less device in the report would share it. `'unknown'` is outside
* the digest's own shape, so it cannot be mistaken for one.
*/
function digestIdentity(identity) {
	if (identity === "") return "unknown";
	return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}
/**
* Projects ONE device record onto the whitelist.
*
* Note what is NOT here: the record's `accessToken`/`tokenExpiresAt` never
* leave this function even though they are present on the input, and
* `desktopIdentity` is replaced by its digest. The `state` is passed in rather
* than read from the record because a record has no state — the projection does.
*
* `limits` are the hello-NEGOTIATED caps (or the conservative fallbacks), which
* are pure numbers with no credential in them and are exactly what an operator
* needs to judge whether a refusal was the peer's cap talking.
*/
function sanitizeDevice(record, state, limits) {
	return {
		deviceId: record.deviceId,
		displayName: record.displayName,
		state,
		enabled: record.enabled,
		hosts: [...record.hosts],
		port: record.port,
		desktopIdentity: digestIdentity(record.desktopIdentity),
		...limits === void 0 ? {} : { limits: {
			heartbeatMs: limits.heartbeatMs,
			subscriptions: limits.subscriptions,
			pageItems: limits.pageItems,
			inFlightRequests: limits.inFlightRequests
		} }
	};
}
/** Narrows an unknown bag to the report's own shapes, dropping everything else. */
function projectDevice(raw) {
	const value = raw ?? {};
	const desktopIdentity = typeof value["desktopIdentity"] === "string" ? value["desktopIdentity"] : "";
	return {
		deviceId: typeof value["deviceId"] === "string" ? value["deviceId"] : "",
		displayName: typeof value["displayName"] === "string" ? value["displayName"] : "",
		state: value["state"] ?? "offline",
		enabled: value["enabled"] === true,
		hosts: Array.isArray(value["hosts"]) ? value["hosts"].map((host) => String(host)) : [],
		port: typeof value["port"] === "number" ? value["port"] : 0,
		desktopIdentity: desktopIdentity === "unknown" || /^[0-9a-f]{12}$/.test(desktopIdentity) ? desktopIdentity : digestIdentity(desktopIdentity),
		...projectLimits(value["limits"])
	};
}
/**
* Re-projects the four numeric limit keys, dropping any foreign key that a
* caller's `limits` object might carry. A whitelist inside the whitelist: the
* shape is rebuilt field by field rather than spread, so a future addition to
* `EffectiveLimits` cannot arrive here unvetted.
*/
function projectLimits(raw) {
	if (raw === null || typeof raw !== "object") return {};
	const value = raw;
	return { limits: {
		heartbeatMs: numberOr(value["heartbeatMs"], 0),
		subscriptions: numberOr(value["subscriptions"], 0),
		pageItems: numberOr(value["pageItems"], 0),
		inFlightRequests: numberOr(value["inFlightRequests"], 0)
	} };
}
function numberOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** The loose-bag view every projection in this module takes of its input. */
function bag(raw) {
	return raw ?? {};
}
/** The capability tri-state, or the honest unknown (`pending`) for anything else. */
function hostStateOr(raw) {
	return raw === "ready" || raw === "unsupported" || raw === "pending" ? raw : "pending";
}
/**
* The five degradation sources as a VALUE, and the reason the projection can
* reject a hand-stuffed one without a second list that could drift: `Record<
* DegradedSource, true>` makes TypeScript refuse a missing member when the union
* grows, which a plain array literal could not.
*/
const DEGRADED_SOURCES = {
	install: true,
	"workspace-list": true,
	"visibility-only": true,
	"scope-version": true,
	"path-normalization": true
};
/** Narrows an unknown value to one of the closed five-source set. */
function isDegradedSource(value) {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEGRADED_SOURCES, value);
}
/** Re-projects the degraded notes onto `{source, reason}`; a foreign source is dropped. */
function projectDegraded(raw) {
	if (!Array.isArray(raw)) return [];
	const notes = [];
	for (const entry of raw) {
		const value = bag(entry);
		const source = value["source"];
		if (!isDegradedSource(source)) continue;
		notes.push({
			source,
			reason: typeof value["reason"] === "string" ? value["reason"] : ""
		});
	}
	return notes;
}
/**
* Re-projects the unmatched-`cwd` evidence onto `{agentId, cwd}`.
*
* `cwd` passes through VERBATIM: not digested, not summarized, not run through
* {@link truncateErrorMessage}. It is a local path, not a credential, and it is
* the one fact that explains "ticked but no tools" — bounding it would destroy
* exactly what an operator opened this endpoint for. An entry whose fields are
* not strings is dropped rather than coerced into a fabricated path.
*/
function projectPathUnmatched(raw) {
	if (!Array.isArray(raw)) return [];
	const entries = [];
	for (const entry of raw) {
		const value = bag(entry);
		const agentId = value["agentId"];
		const cwd = value["cwd"];
		if (typeof agentId !== "string" || typeof cwd !== "string") continue;
		entries.push({
			agentId,
			cwd
		});
	}
	return entries;
}
/**
* Projects the scope segment onto its FIELD whitelist (Task 9 ③).
*
* The whitelist is applied on the way OUT, to whatever the source handed over:
* the shape is rebuilt field by field — `mode`, `revision`, `workspaceIds`,
* `host{state,capable,reason,degraded}` and `pathUnmatched[{agentId,cwd}]`, and
* nothing else — so a probe key (`accessToken`, `desktopIdentity`, `identity`)
* cannot ride along into the report even when a caller stuffs it into the input.
* Applied on the way IN it would not be a whitelist at all: an unlisted field
* would still reach the body.
*
* A missing segment reads as the strict side (`DEFAULT_SCOPE`, "nobody") with
* the capability at `pending` — the same honest unknown a failed device read
* reports as `offline`, not a claim that any document was read.
*/
function projectScope(raw) {
	const value = bag(raw);
	const host = bag(value["host"]);
	return {
		mode: value["mode"] === "global" ? "global" : DEFAULT_SCOPE.mode,
		revision: numberOr(value["revision"], DEFAULT_SCOPE.revision),
		workspaceIds: Array.isArray(value["workspaceIds"]) ? value["workspaceIds"].map((id) => String(id)) : [],
		host: projectHostFace({
			state: hostStateOr(host["state"]),
			reason: typeof host["reason"] === "string" ? host["reason"] : ""
		}, projectDegraded(host["degraded"])),
		pathUnmatched: projectPathUnmatched(value["pathUnmatched"])
	};
}
/**
* The sanitizer, as a pure function over a loose bag.
*
* Exposed (rather than kept private to {@link buildDiagnostics}) because it is
* the unit the contract suite drives with a deliberately over-stuffed input:
* a caller that hands this an object carrying every credential field in the
* record must still get a report without any of them.
*/
function sanitizeDiagnostics(source) {
	return {
		devices: (source.devices ?? []).map(projectDevice),
		sessions: (source.sessions ?? []).map((raw) => {
			const value = raw ?? {};
			const cursor = value["cursor"];
			const deviceId = typeof value["deviceId"] === "string" ? value["deviceId"] : "";
			const sessionId = typeof value["sessionId"] === "string" ? value["sessionId"] : "";
			return {
				sessionId,
				deviceId,
				subscriptions: typeof value["subscriptions"] === "number" ? value["subscriptions"] : 0,
				...cursor === void 0 ? {} : { cursor: {
					sessionId: typeof cursor["sessionId"] === "string" ? cursor["sessionId"] : sessionId,
					streamEpoch: typeof cursor["streamEpoch"] === "string" ? cursor["streamEpoch"] : "",
					seq: typeof cursor["seq"] === "string" ? cursor["seq"] : ""
				} }
			};
		}),
		recentErrors: (source.recentErrors ?? []).map((raw) => {
			const value = raw ?? {};
			return {
				at: typeof value["at"] === "string" ? value["at"] : (/* @__PURE__ */ new Date(0)).toISOString(),
				...typeof value["deviceId"] === "string" ? { deviceId: value["deviceId"] } : {},
				...typeof value["sessionId"] === "string" ? { sessionId: value["sessionId"] } : {},
				reason: typeof value["reason"] === "string" ? value["reason"] : "INTERNAL",
				message: truncateErrorMessage(typeof value["message"] === "string" ? value["message"] : "")
			};
		}),
		stats: {
			connections: source.stats?.connections ?? 0,
			sockets: source.stats?.sockets ?? 0,
			connectionsBuilt: source.stats?.connectionsBuilt ?? 0,
			subscriptions: source.stats?.subscriptions ?? 0
		},
		scope: projectScope(source.scope)
	};
}
const DEFAULT_IDENTITY = {
	name: "dsh-cherry-bridge",
	prefix: "/cherry-remote/api"
};
/**
* Aggregates the live report.
*
* Every source is read through a guard: a diagnostics endpoint that throws
* because one device's connection resolver misbehaved would be useless exactly
* when it is needed most. A failed device is reported as `offline` (the honest
* "unknown") and the rest of the report still goes out.
*/
function buildDiagnostics(sources, identity = DEFAULT_IDENTITY) {
	let records = [];
	try {
		records = sources.store.list();
	} catch {
		records = [];
	}
	const devices = [];
	const sessions = [];
	for (const record of records) {
		let state = "offline";
		let limits;
		try {
			const connection = sources.connect(record.deviceId);
			state = connection.state;
			limits = connection.limits;
		} catch {
			state = "offline";
			limits = void 0;
		}
		devices.push(sanitizeDevice(record, state, limits));
	}
	try {
		for (const entry of sources.sessions?.() ?? []) sessions.push({
			sessionId: entry.sessionId,
			deviceId: entry.deviceId,
			subscriptions: entry.subscriptions,
			...entry.cursor === void 0 ? {} : { cursor: { ...entry.cursor } }
		});
	} catch {}
	let recentErrors = [];
	try {
		recentErrors = sources.recentErrors?.() ?? [];
	} catch {
		recentErrors = [];
	}
	let stats = {};
	try {
		stats = sources.stats?.() ?? {};
	} catch {
		stats = {};
	}
	let scope;
	try {
		scope = sources.scope?.();
	} catch {
		scope = void 0;
	}
	const projected = sanitizeDiagnostics({
		devices,
		sessions,
		recentErrors,
		stats,
		scope
	});
	return {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		plugin: {
			name: identity.name,
			prefix: identity.prefix
		},
		devices: projected.devices,
		sessions: projected.sessions,
		stats: projected.stats,
		recentErrors: projected.recentErrors,
		scope: reportScope(projected.scope),
		contractDifferences: CONTRACT_DIFFERENCES.map((entry) => ({
			id: entry.id,
			title: entry.title
		}))
	};
}
//#endregion
//#region src/defaults.ts
/**
* The cross-cutting default constants, in ONE place.
*
* These two values are contractual (spec §3.4 / §3.5) and are consumed by three
* different modules: the assembly's config resolver (`index.ts`), the connection
* layer's rate limiter, and the subscription layer's cache budget. They used to
* be declared privately in each, which is a drift surface with a silent failure
* mode: change one copy and the assembly's documented default stops matching the
* behaviour a layer actually applies, with no test able to see the disagreement.
*
* IMPORT CYCLE RULE: this module imports NOTHING from `index.ts`,
* `connection.ts` or `subscriptions.ts`. It is a leaf, so all three can depend
* on it directly. `index.ts` re-exports both names, keeping the public surface
* (and the contract test that pins it) stable.
*/
/**
* The second-level smoothed request budget: admissions per second for business
* RPCs (spec §3.4). Injectable through plugin config; this is the fallback.
*/
const DEFAULT_RATE_BUDGET_PER_SECOND = 32;
/** 2 MiB of event text cached per session (spec §3.5). */
const DEFAULT_PER_SESSION_CACHE_BYTES = 2097152;
/**
* Byte-safe per-page clamps for the aggregated `agent.*.list` walks.
*
* WHY THESE EXIST: every JSON-RPC record on the wire is hard-capped at
* `remoteLimits.recordBytes` = 65,536 bytes — the transport refuses a larger
* record by aborting the connection, so every in-flight request then fails
* with "JSON-RPC channel closed". The Cherry Studio desktop's `pageOf`
* (src/main/services/remoteAccess/agentQueries.ts) slices pages by COUNT
* alone, so a client that asks for `pageItems` (100) fat parts receives a
* record the transport must kill: reading a complex session (many parts per
* message, or many messages) became a deterministic connection reset before
* these clamps.
*
* PARTS_LIST_PAGE_CLAMP and INTERACTIONS_LIST_PAGE_CLAMP are DERIVED from the
* strict UTF-8 worst case (4 bytes per character — emoji and CJK extension
* planes), not tuned: the peer may inline up to 4,096 CHARACTERS of text per
* field (its `INLINE_TEXT_LIMIT`), an interaction record additionally carries
* a 2,048-character summary, and each item adds an envelope (ids are
* schema-capped at 256 characters each — roughly 1 KiB across an item's id
* fields, which the page margin below absorbs). Dividing the 64 KiB record
* budget (minus a 2 KiB page/margin overhead) by each list's worst-case item
* gives the clamp.
*
* LIST_PAGE_CLAMP is pragmatic, not provable: message/session/agent records
* carry large schema-bounded fields (`partIds` up to 4,096 entries, titles up
* to 4,096 characters), so no count is provably sub-budget. 16 covers every
* observed record with headroom; the complete fix is byte-budgeted paging on
* the server (tracked upstream).
*/
/** Usable bytes of one wire record after page/margin overhead. */
const RECORD_BUDGET_BYTES = 63488;
/** Parts per parts.list page: one inline content field per part. */
const PARTS_LIST_PAGE_CLAMP = Math.floor(RECORD_BUDGET_BYTES / 16896);
/** Interactions per interactions.list page: inline input + inline summary. */
const INTERACTIONS_LIST_PAGE_CLAMP = Math.floor(RECORD_BUDGET_BYTES / 25088);
//#endregion
//#region src/urlHost.ts
/**
* Renders a host as a URL authority component. The device archive and pairing
* flow store BARE hosts (plan-mandated normalization), so a bare IPv6 literal
* must be bracketed before it is spliced into a URL — `ws://::1:35543/...`
* is not a valid URL and `new WebSocket(...)` throws synchronously on it.
*
* Shared home for the dial sites: both `connection.ts` (per-device dial) and
* `pairing.ts` (candidate dial) splice hosts into URLs and must bracket the
* same way.
*/
function urlHost(host) {
	return host.includes(":") ? `[${host}]` : host;
}
//#endregion
//#region src/connection.ts
/**
* The structured §6 "设备离线" error: tool calls against a non-connected
* device fail fast with `{device, state}` and never implicitly reconnect.
*/
var DeviceUnavailableError = class extends Error {
	device;
	state;
	constructor(device, state) {
		super(`device ${device} is ${state}`);
		this.name = "DeviceUnavailableError";
		this.device = device;
		this.state = state;
		Object.setPrototypeOf(this, new.target.prototype);
	}
};
/**
* CEILING for the business-request window — not the window itself. The window
* is owned by the rpc layer and is sized from the peer's hello-reported
* `inFlightRequests` (spec §3.4「取回报一半」): see
* {@link businessWindowFor}. The ceiling binds only when HALF the peer's report
* exceeds it — a peer reporting 64 gets 8, not 32.
*
* The FALLBACK is a DIFFERENT path and does not land on this number. When the
* peer's hello says nothing about `inFlightRequests`, {@link FALLBACK_LIMITS}
* supplies 8, and `#handshake` then runs that through the same half-the-report
* rule as any other report: `floor(8 / 2)` = 4. So a silent peer gets a
* business window of 4 — deliberately the CONSERVATIVE reading, since the whole
* point of the halving is to stay inside an allowance the peer never confirmed.
* The client is constructed at 8 only for the window before hello answers.
*/
const BUSINESS_MAX_IN_FLIGHT = 8;
const FALLBACK_LIMITS = {
	heartbeatMs: 2e4,
	subscriptions: 8,
	pageItems: 100,
	inFlightRequests: 8
};
const DEFAULT_BACKOFF_INITIAL_MS = 1e3;
const DEFAULT_BACKOFF_MAX_MS = 6e4;
const DEFAULT_REFRESH_GRACE_MS = 3e4;
const DEFAULT_CONNECT_TIMEOUT_MS$1 = 1e4;
const DEFAULT_PROTOCOL_VERSIONS = [1];
/** Ping-silence multiplier: 2×heartbeatMs without a pong judges the line dead. */
const SILENCE_FACTOR = 2;
/** Bare rejection the rpc layer uses once the channel can no longer answer. */
const CHANNEL_CLOSED_RE = /^JSON-RPC channel closed$/;
/**
* Second-level rate smoothing for business requests: admissions are paced at
* least `(window+margin)/budget` ms apart, so any 1-second window — measured
* on the client's admission times OR the peer's (compressed) arrival times —
* observes at most floor(window/minGap)+1 ≤ budget requests. This is rate
* shaping ONLY — the in-flight concurrency cap belongs to JsonRpcClient.
*/
var SecondWindowRateLimiter = class {
	budgetPerSecond;
	#admitted = [];
	#minGapMs;
	constructor(budgetPerSecond) {
		this.budgetPerSecond = budgetPerSecond;
		this.#minGapMs = Math.ceil(1150 / Math.max(budgetPerSecond, 1));
	}
	async acquire() {
		for (;;) {
			const now = Date.now();
			while (this.#admitted.length > 0 && now - this.#admitted[0] >= 1150) this.#admitted.shift();
			const last = this.#admitted[this.#admitted.length - 1];
			if (last === void 0 || now - last >= this.#minGapMs) {
				this.#admitted.push(now);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, this.#minGapMs - (now - last) + 1));
		}
	}
};
const noop$1 = () => {};
function makeSilentLogger$1() {
	const log = () => {};
	log.error = noop$1;
	log.trace = noop$1;
	log.enabled = false;
	log.newScope = () => log;
	return log;
}
const silentComponentLogger$1 = { forComponent: () => makeSilentLogger$1() };
/** Noise reported the peer's static key does not match the pinned identity. */
var IdentityMismatchError = class extends Error {
	constructor() {
		super("peer static key does not match the pinned desktopIdentity");
	}
};
/** The peer rejected the hello echo with INVALID_CONNECTION_STATE. */
var ProtocolVersionError = class extends Error {
	constructor(cause) {
		super(`protocol version confirmation rejected: ${cause}`);
	}
};
/** authenticate was rejected with GRANT_REVOKED / UNAUTHENTICATED. */
var AuthRejectedError = class extends Error {
	reason;
	constructor(reason) {
		super(`authenticate rejected with ${reason}`);
		this.reason = reason;
	}
};
/** The attempt was cancelled (close() moved the epoch on). */
var CancelledError = class extends Error {
	constructor() {
		super("connection attempt cancelled");
	}
};
/**
* Every candidate host failed to dial (distinct from a single host failing
* while a later one succeeded). Carries the last per-host error as its message
* so the log still names a concrete socket failure.
*/
var AllHostsUnreachableError = class extends Error {
	deviceId;
	hosts;
	lastError;
	constructor(deviceId, hosts, lastError) {
		super(`all candidate hosts unreachable (last: ${lastError.message})`);
		this.deviceId = deviceId;
		this.hosts = hosts;
		this.lastError = lastError;
		this.name = "AllHostsUnreachableError";
		Object.setPrototypeOf(this, new.target.prototype);
	}
};
/** True when the attempt failed because NO candidate host could be dialed. */
function isAllHostsUnreachable(error) {
	return error instanceof AllHostsUnreachableError;
}
/**
* Whether a failed establishment attempt blames THIS ADDRESS or the PAIRING.
*
* The per-host class is the default because the alternative is worse: a stale
* first address on a multi-homed desktop would otherwise abort the whole pass
* even though a later candidate would have connected. The terminal faces are
* named explicitly:
*
*  - {@link IdentityMismatchError} — the peer's pinned static key is wrong. That
*    is about the PAIRING, and the supervisor marks the device
*    `identity-mismatch`; another address cannot fix it.
*  - {@link ProtocolVersionError} — the peer refused the version echo. Also the
*    pairing, not the address.
*  - {@link AuthRejectedError} — authenticate was refused (GRANT_REVOKED /
*    UNAUTHENTICATED). Same reasoning.
*  - {@link CancelledError} — `close()` raced the attempt; the supervisor's epoch
*    guard handles it, and falling through to another candidate would be wrong.
*/
function isPerHostFailure(error) {
	return !(error instanceof IdentityMismatchError || error instanceof ProtocolVersionError || error instanceof AuthRejectedError || error instanceof CancelledError);
}
function rpcReason$1(error) {
	if (error instanceof JsonRpcRequestError) {
		const data = error.data;
		if (data !== null && typeof data === "object" && typeof data.reason === "string") return data.reason;
	}
}
function isPeerIdentityMismatch(error) {
	if (!(error instanceof Error)) return false;
	if (error.name === "UnexpectedPeerError") return true;
	return /does not match expected remote identity key/i.test(error.message);
}
/** Parses a positive finite number, or returns undefined for the fallback. */
function positive$2(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* Sizes the business in-flight window from the peer's hello-reported
* `inFlightRequests`, per spec §3.4「取回报一半」: take HALF the allowance, so
* the client never saturates the peer's own concurrency budget and leaves room
* for the peer's other sessions.
*
* `BUSINESS_MAX_IN_FLIGHT` is the CEILING on the result, not a floor: a peer
* reporting 64 gets 8, not 32. The floor is 1, because a report of 1 would
* otherwise yield `floor(1/2) = 0` — a window that admits nothing and can never
* be released by anything, i.e. a permanent deadlock rather than a limit.
*/
function businessWindowFor(reportedInFlightRequests) {
	return Math.max(1, Math.min(BUSINESS_MAX_IN_FLIGHT, Math.floor(reportedInFlightRequests / 2)));
}
function defer() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(noop$1);
	return {
		promise,
		resolve,
		reject
	};
}
/**
* One supervised connection per paired device.
*
* Concurrency ownership: the JsonRpcClient is constructed with
* maxInFlight 8 and is the ONLY in-flight limiter; this class adds rate
* smoothing on top and deliberately no second semaphore. Housekeeping RPCs
* (hello/authenticate/ping/refresh) call the raw client directly — they
* bypass the rate smoothing but share the in-flight window, which is the
* documented tradeoff of a single-channel client (see the task report):
* under a fully saturated business window a ping may queue, bounded by the
* 2×heartbeatMs silence window (40s default).
*/
var DeviceConnection = class {
	record;
	#identity;
	#limiter;
	#backoffInitialMs;
	#backoffMaxMs;
	#refreshGraceMs;
	#connectTimeoutMs;
	#rpcTimeoutMs;
	#protocolVersions;
	#helloProtocolVersions;
	#stateListeners = /* @__PURE__ */ new Set();
	/** Notification handlers, re-attached to every new client after a reconnect. */
	#notificationHandlers = /* @__PURE__ */ new Set();
	/**
	* Subset of {@link #notificationHandlers} already attached to the CURRENT
	* live client's listener list. Cleared whenever the link is torn down, since
	* the next client starts with no listeners of its own.
	*/
	#attachedHandlers = /* @__PURE__ */ new Set();
	#timers = /* @__PURE__ */ new Map();
	#state = "offline";
	#limits = { ...FALLBACK_LIMITS };
	#running = false;
	#epoch = 0;
	#attempt = 0;
	#cycle = defer();
	#link;
	#refreshFirstFailureAt;
	#pendingPings = /* @__PURE__ */ new Set();
	#token;
	#tokenExpiresAt;
	constructor(opts) {
		this.record = opts.record;
		this.#identity = opts.identity;
		this.#limiter = new SecondWindowRateLimiter(opts.rateBudgetPerSecond ?? 32);
		this.#backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
		this.#backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.#refreshGraceMs = opts.refreshGraceMs ?? DEFAULT_REFRESH_GRACE_MS;
		this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS$1;
		this.#rpcTimeoutMs = opts.rpcTimeoutMs;
		this.#protocolVersions = opts.protocolVersions ?? DEFAULT_PROTOCOL_VERSIONS;
		this.#helloProtocolVersions = opts.helloProtocolVersions ?? this.#protocolVersions;
	}
	/**
	* The business RPC surface: rate-smoothed and gated on `connected`. Typed
	* as JsonRpcClient (a delegating Proxy), so tools call exactly the landed
	* rpc API while the connection owns pacing and the offline fail-fast.
	*/
	get rpc() {
		return this.#facade;
	}
	/** Effective limits: hello-reported values with conservative fallbacks applied. */
	get limits() {
		return this.#limits;
	}
	get state() {
		return this.#state;
	}
	/**
	* Whether a dialed link is currently committed.
	*
	* Read-only view of state this class already owns, exposed because the
	* `connecting`-with-a-link window is a REAL state a test must be able to
	* target: `#establish` commits `#link` before `#handshake` completes, so
	* "state is connecting" and "no link exists" are different situations with
	* different correct behaviour for a business request.
	*/
	get hasLink() {
		return this.#link !== void 0;
	}
	/**
	* Business-facing rpc facade.
	*
	* `dispose` is ALWAYS a local no-op, even when a client is live. Tearing down
	* the live JsonRpcClient through this property would kill the connection's
	* own housekeeping channel (heartbeat/refresh) and leave the supervisor
	* believing it is `connected` with no way to notice — `close()` is the only
	* supported teardown. Everything else is forwarded to the live client.
	*
	* `onNotification` is registry-owned: handlers are remembered for the whole
	* lifecycle and re-attached on every reconnect, and an ALREADY-live client is
	* attached to exactly once per handler.
	*/
	#facade = new Proxy({}, { get: (_target, prop) => {
		if (prop === "request") return (method, params, opts) => this.#businessRequest(method, params, opts);
		if (prop === "onNotification") return (handler) => {
			this.#notificationHandlers.add(handler);
			const link = this.#link;
			if (link === void 0) return;
			if (this.#attachedHandlers.has(handler)) return;
			link.client.onNotification(handler);
			this.#attachedHandlers.add(handler);
		};
		if (prop === "dispose") return noop$1;
		const link = this.#link;
		if (link === void 0) return void 0;
		const value = Reflect.get(link.client, prop);
		return typeof value === "function" ? value.bind(link.client) : value;
	} });
	/**
	* Subscribes to state transitions (fired on change only). The state set is
	* closed: connected | connecting | offline | disabled | identity-mismatch.
	*/
	onState(cb) {
		this.#stateListeners.add(cb);
	}
	/**
	* Starts (or joins) the supervised lifecycle. Resolves once this cycle
	* reaches `connected`; rejects with the cycle's failure. Transient
	* failures keep being retried in the background by the backoff loop even
	* after this promise rejected.
	*/
	connect() {
		if (!this.record.enabled) {
			this.#setState("disabled");
			return Promise.reject(/* @__PURE__ */ new Error(`device ${this.record.deviceId} is disabled`));
		}
		if (this.#state === "connected") return Promise.resolve();
		if (!this.#running) {
			this.#running = true;
			this.#cycle = defer();
			this.#tryEstablish();
		}
		return this.#cycle.promise;
	}
	/** Tears the supervised lifecycle down: timers, channel, client, retries. */
	async close() {
		this.#running = false;
		this.#epoch += 1;
		this.#clearAllTimers();
		this.#teardownLink();
		this.#setState("offline");
		this.#cycle.reject(/* @__PURE__ */ new Error(`device ${this.record.deviceId}: connection closed`));
	}
	#tryEstablish() {
		if (!this.#running) return;
		const epoch = this.#epoch += 1;
		this.#attempt += 1;
		this.#establish(epoch).then(() => {
			if (epoch !== this.#epoch) return;
			this.#attempt = 0;
			this.#cycle.resolve();
		}, (error) => {
			if (epoch !== this.#epoch) return;
			this.#onAttemptFailed(error);
		});
	}
	#onAttemptFailed(error) {
		this.#teardownLink();
		if (error instanceof CancelledError) return;
		if (error instanceof IdentityMismatchError) {
			this.#running = false;
			this.#setState("identity-mismatch");
			console.error(`[cherry-remote] device ${this.record.deviceId}: ${error.message}; marked identity-mismatch and disconnected — re-pair the device`);
			this.#cycle.reject(/* @__PURE__ */ new Error(`device ${this.record.deviceId}: identity mismatch`));
			return;
		}
		if (error instanceof ProtocolVersionError) {
			this.#running = false;
			this.#setState("offline");
			console.error(`[cherry-remote] device ${this.record.deviceId}: protocol version incompatible (${error.message}); upgrade Cherry Studio / the plugin`);
			this.#cycle.reject(/* @__PURE__ */ new Error(`device ${this.record.deviceId}: protocol version incompatible`));
			return;
		}
		if (error instanceof AuthRejectedError) {
			this.#running = false;
			this.#setState("offline");
			const hint = error.reason === "GRANT_REVOKED" ? "grant revoked by the desktop — re-pair the device" : "pairing invalid (local identity regenerated or device removed on the peer) — re-pair the device";
			console.error(`[cherry-remote] device ${this.record.deviceId}: ${hint}`);
			this.#cycle.reject(/* @__PURE__ */ new Error(`device ${this.record.deviceId}: authenticate rejected (${error.reason})`));
			return;
		}
		this.#setState("offline");
		this.#cycle.reject(error instanceof Error ? error : new Error(String(error)));
		this.#cycle = defer();
		if (!this.#running) return;
		const delay = this.#backoffDelay();
		const hint = isAllHostsUnreachable(error) ? " — all candidate addresses were unreachable; if the desktop moved, update them via the device card 地址维护 (address maintenance)" : "";
		console.warn(`[cherry-remote] device ${this.record.deviceId} offline (${error instanceof Error ? error.message : String(error)}); reconnecting in ${delay}ms${hint}`);
		this.#setTimer("backoff", setTimeout(() => this.#tryEstablish(), delay));
	}
	#backoffDelay() {
		const exponent = Math.min(Math.max(this.#attempt - 1, 0), 30);
		return Math.min(this.#backoffInitialMs * 2 ** exponent, this.#backoffMaxMs);
	}
	/**
	* One establishment pass: try each candidate host in order. Per-host
	* network failures fall through to the next candidate — the §6
	* 「候选地址全部不可达」 verdict only holds when EVERY host failed.
	*
	* "Per-host" covers the CHANNEL-LEVEL handshake failures as well as the dial:
	* a socket that opens and then dies mid-handshake (the peer accepted the TCP
	* connection and went away, a proxy reset it, the Noise exchange was cut) is a
	* property of THAT ADDRESS, and a multi-homed desktop whose first address is
	* stale is exactly the case the candidate list exists for. The terminal faces
	* — identity mismatch, protocol-version confirmation, rejected authentication —
	* are properties of the PAIRING, so they still abort the whole pass instead of
	* being blamed on one address.
	*/
	async #establish(epoch) {
		this.#setState("connecting");
		if (this.record.hosts.length === 0) throw new AllHostsUnreachableError(this.record.deviceId, this.record.hosts, /* @__PURE__ */ new Error("the device record has no candidate hosts"));
		let lastError = /* @__PURE__ */ new Error(`device ${this.record.deviceId}: all candidate hosts unreachable`);
		for (const host of this.record.hosts) {
			if (!this.#running || epoch !== this.#epoch) throw new CancelledError();
			let link;
			try {
				link = await this.#dial(host, this.record.port, epoch);
			} catch (error) {
				if (error instanceof IdentityMismatchError) throw error;
				lastError = error instanceof Error ? error : new Error(String(error));
				continue;
			}
			this.#link = link;
			try {
				await this.#handshake(link, epoch);
				return;
			} catch (error) {
				if (error instanceof CancelledError || !this.#running || epoch !== this.#epoch) throw new CancelledError();
				if (!isPerHostFailure(error)) throw error;
				this.#teardownLink();
				lastError = error instanceof Error ? error : new Error(String(error));
				continue;
			}
		}
		throw new AllHostsUnreachableError(this.record.deviceId, this.record.hosts, lastError);
	}
	async #dial(host, port, epoch) {
		const url = `ws://${urlHost(host)}:${port}${remoteConnectPath}`;
		const ws = new WebSocket(url);
		const controller = new AbortController();
		const opened = new Promise((resolve) => ws.once("open", () => resolve()));
		const failure = new Promise((_, reject) => {
			const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`connect to ${host}:${port} timed out`)), this.#connectTimeoutMs);
			ws.once("open", () => clearTimeout(timer));
			ws.once("error", (error) => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error(`host ${host}:${port} unreachable: ${error.message}`));
			});
		});
		try {
			await Promise.race([opened, failure]);
		} catch (error) {
			ws.terminate();
			throw error;
		}
		ws.on("close", () => this.#onLinkLost(epoch, "socket closed"));
		ws.on("error", () => this.#onLinkLost(epoch, "socket error"));
		const stream = new RemoteSocketStream(toRemoteSocket(ws), silentComponentLogger$1.forComponent("device"), "outbound");
		let channel;
		try {
			channel = await connectSecureChannel(stream, {
				identity: this.#identity,
				logger: silentComponentLogger$1,
				protocolVersions: [...this.#protocolVersions],
				signal: controller.signal,
				remoteIdentity: this.record.desktopIdentity
			});
		} catch (error) {
			ws.terminate();
			if (isPeerIdentityMismatch(error)) throw new IdentityMismatchError();
			throw error instanceof Error ? error : new Error(String(error));
		}
		if (channel.remoteIdentity !== this.record.desktopIdentity) {
			channel.close().catch(noop$1);
			ws.close();
			throw new IdentityMismatchError();
		}
		const client = new JsonRpcClient(channel, {
			maxInFlight: BUSINESS_MAX_IN_FLIGHT,
			...this.#rpcTimeoutMs === void 0 ? {} : { timeoutMs: this.#rpcTimeoutMs }
		});
		return {
			ws,
			channel,
			client,
			controller,
			epoch
		};
	}
	/** hello (protocol confirmation) then authenticate (token acquisition). */
	async #handshake(link, epoch) {
		const { client } = link;
		let hello;
		try {
			hello = await this.#houseCall(link, "connection.hello", { protocolVersions: [...this.#helloProtocolVersions] });
		} catch (error) {
			if (rpcReason$1(error) === "INVALID_CONNECTION_STATE") throw new ProtocolVersionError(String(error));
			throw error instanceof Error ? error : new Error(String(error));
		}
		this.#limits = {
			heartbeatMs: positive$2(hello.heartbeatMs) ?? FALLBACK_LIMITS.heartbeatMs,
			subscriptions: positive$2(hello.limits?.["subscriptions"]) ?? FALLBACK_LIMITS.subscriptions,
			pageItems: positive$2(hello.limits?.["pageItems"]) ?? FALLBACK_LIMITS.pageItems,
			inFlightRequests: positive$2(hello.limits?.["inFlightRequests"]) ?? FALLBACK_LIMITS.inFlightRequests
		};
		link.client.updateMaxInFlight(businessWindowFor(this.#limits.inFlightRequests));
		let auth;
		try {
			auth = await this.#authenticate(link);
		} catch (error) {
			const reason = rpcReason$1(error);
			if (reason === "GRANT_REVOKED" || reason === "UNAUTHENTICATED") throw new AuthRejectedError(reason);
			throw error instanceof Error ? error : new Error(String(error));
		}
		if (epoch !== this.#epoch) {
			client.dispose();
			link.channel.close().catch(noop$1);
			link.ws.close();
			throw new CancelledError();
		}
		this.#token = auth.accessToken;
		this.#tokenExpiresAt = Date.parse(auth.expiresAt);
		this.record.accessToken = auth.accessToken;
		this.record.tokenExpiresAt = this.#tokenExpiresAt;
		this.#refreshFirstFailureAt = void 0;
		this.#pendingPings.clear();
		for (const handler of this.#notificationHandlers) {
			if (this.#attachedHandlers.has(handler)) continue;
			link.client.onNotification(handler);
			this.#attachedHandlers.add(handler);
		}
		this.#startHeartbeat(epoch);
		this.#scheduleRefresh(epoch);
		this.#setState("connected");
		console.info(`[cherry-remote] device ${this.record.deviceId} connected (${digestIdentity(link.channel.remoteIdentity)})`);
	}
	/**
	* authenticate with the stored token; a stale token (TOKEN_EXPIRED /
	* UNAUTHENTICATED) is retried exactly once without it before the pairing
	* is declared invalid.
	*/
	async #authenticate(link) {
		const stored = this.#token ?? this.record.accessToken;
		const params = (withToken) => ({
			deviceId: this.record.deviceId,
			...withToken && stored !== void 0 ? { accessToken: stored } : {}
		});
		try {
			return await this.#houseCall(link, "connection.authenticate", params(stored !== void 0));
		} catch (error) {
			const reason = rpcReason$1(error);
			if (stored !== void 0 && (reason === "TOKEN_EXPIRED" || reason === "UNAUTHENTICATED")) return await this.#houseCall(link, "connection.authenticate", params(false));
			throw error;
		}
	}
	#startHeartbeat(epoch) {
		this.#setTimer("heartbeat", setInterval(() => this.#pingTick(epoch), this.#limits.heartbeatMs));
	}
	#pingTick(epoch) {
		if (epoch !== this.#epoch || this.#link === void 0) return;
		const windowMs = this.#limits.heartbeatMs * SILENCE_FACTOR;
		const now = Date.now();
		for (const ping of this.#pendingPings) if (now - ping.sentAt >= windowMs) {
			this.#loseLink(epoch, `ping silence exceeded ${windowMs}ms`);
			return;
		}
		const ping = {
			nonce: randomUUID(),
			sentAt: now
		};
		this.#pendingPings.add(ping);
		this.#houseCall(this.#link, "connection.ping", { nonce: ping.nonce }, windowMs).then(() => this.#pendingPings.delete(ping), (error) => {
			if (error instanceof Error && CHANNEL_CLOSED_RE.test(error.message)) {
				this.#pendingPings.delete(ping);
				this.#onLinkLost(epoch, "channel closed");
			}
		});
	}
	/** Schedules the next refresh from the ACTUAL expiresAt (never hardcoded). */
	#scheduleRefresh(epoch) {
		this.#clearTimer("refresh");
		if (this.#tokenExpiresAt === void 0) return;
		const ttl = this.#tokenExpiresAt - Date.now();
		const lead = Math.min(Math.max(Math.floor(ttl / 2), 1), this.#refreshGraceMs);
		const delay = Math.max(ttl - lead, 1);
		this.#setTimer("refresh", setTimeout(() => void this.#refresh(epoch), delay));
	}
	async #refresh(epoch) {
		const link = this.#link;
		if (epoch !== this.#epoch || link === void 0) return;
		try {
			const result = await this.#houseCall(link, "connection.refresh", {});
			this.#token = result.accessToken;
			this.#tokenExpiresAt = Date.parse(result.expiresAt);
			this.record.accessToken = result.accessToken;
			this.record.tokenExpiresAt = this.#tokenExpiresAt;
			this.#refreshFirstFailureAt = void 0;
			this.#scheduleRefresh(epoch);
		} catch (error) {
			if (error instanceof Error && CHANNEL_CLOSED_RE.test(error.message)) return;
			const first = this.#refreshFirstFailureAt ??= Date.now();
			if (Date.now() - first >= this.#refreshGraceMs) {
				console.error(`[cherry-remote] device ${this.record.deviceId}: token refresh kept failing beyond the ${this.#refreshGraceMs}ms grace window; going offline — check whether the desktop removed this device`);
				this.#loseLink(epoch, "refresh grace expired");
				return;
			}
			this.#setTimer("refreshRetry", setTimeout(() => void this.#refresh(epoch), Math.max(1, Math.floor(this.#refreshGraceMs / 4))));
		}
	}
	#onLinkLost(epoch, reason) {
		if (epoch !== this.#epoch || this.#state !== "connected") return;
		this.#loseLink(epoch, reason);
	}
	#loseLink(epoch, reason) {
		if (epoch !== this.#epoch) return;
		this.#teardownLink();
		this.#setState("offline");
		this.#cycle = defer();
		if (!this.#running) return;
		const delay = this.#backoffDelay();
		console.warn(`[cherry-remote] device ${this.record.deviceId} link lost (${reason}); reconnecting in ${delay}ms with fresh authentication`);
		this.#setTimer("backoff", setTimeout(() => this.#tryEstablish(), delay));
	}
	#teardownLink() {
		const link = this.#link;
		this.#link = void 0;
		this.#clearTimer("heartbeat");
		this.#clearTimer("refresh");
		this.#clearTimer("refreshRetry");
		this.#pendingPings.clear();
		this.#refreshFirstFailureAt = void 0;
		this.#attachedHandlers.clear();
		if (link !== void 0) {
			link.client.disposeForLinkLoss();
			link.channel.close().catch(noop$1);
			try {
				link.ws.close();
			} catch {}
			link.controller.abort();
		}
	}
	#setTimer(name, timer) {
		this.#clearTimer(name);
		this.#timers.set(name, timer);
	}
	#clearTimer(name) {
		const timer = this.#timers.get(name);
		if (timer !== void 0) {
			clearTimeout(timer);
			clearInterval(timer);
			this.#timers.delete(name);
		}
	}
	#clearAllTimers() {
		for (const name of [...this.#timers.keys()]) this.#clearTimer(name);
	}
	/**
	* Housekeeping call on the raw client: bypasses rate smoothing (ping and
	* refresh are 1/heartbeatMs-scale and must not be delayed by business
	* pacing) while sharing the rpc layer's in-flight window.
	*/
	#houseCall(link, method, params, timeoutMs) {
		return link.client.request(method, params, timeoutMs === void 0 ? void 0 : { timeoutMs });
	}
	/** Business request: offline fail-fast, then rate smoothing, then the rpc window. */
	async #businessRequest(method, params, opts) {
		if (this.#state !== "connected") {
			console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`);
			throw new DeviceUnavailableError(this.record.deviceId, this.#state);
		}
		await this.#limiter.acquire();
		const link = this.#link;
		if (this.#state !== "connected" || link === void 0) {
			console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`);
			throw new DeviceUnavailableError(this.record.deviceId, this.#state);
		}
		return link.client.request(method, params, opts);
	}
	#setState(next) {
		if (this.#state === next) return;
		this.#state = next;
		console.info(`[cherry-remote] device ${this.record.deviceId} state: ${next}`);
		for (const cb of [...this.#stateListeners]) try {
			cb(next);
		} catch (error) {
			console.warn(`[cherry-remote] state listener threw for ${this.record.deviceId}`, error);
		}
	}
};
//#endregion
//#region src/pairing.ts
/** The structured §6 pairing failure currency. */
var PairingError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.name = "PairingError";
		this.kind = kind;
		Object.setPrototypeOf(this, new.target.prototype);
	}
};
const PAYLOAD_TYPE = "cherry-studio-pair";
const PAYLOAD_VERSION = 2;
/** Overall payload ceiling: a QR code never approaches this. */
const MAX_PAYLOAD_BYTES = 10240;
/** `opaqueId` cap for invitationId/invitationSecret/desktopIdentity. */
const OPAQUE_ID_MAX = 256;
/** The claim's deviceName cap; a hostname may reach 253, so it is truncated. */
const DEVICE_NAME_MAX = 64;
/** Bounds a single candidate host string (IPv6 literals are ~45). */
const HOST_MAX$1 = 256;
/** Matches the protocol's unicodeText: no lone UTF-16 surrogates. */
const LONE_SURROGATE_RE$1 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Fields the implementation consumes; everything else in the payload is ignored. */
const KNOWN_FIELDS = /* @__PURE__ */ new Set([
	"v",
	"t",
	"port",
	"ips",
	"invitationId",
	"invitationSecret",
	"desktopIdentity",
	"protocolVersions"
]);
/**
* A payload-validation failure. It IS a {@link PairingError} so callers see one
* error currency, and it is raised before any socket is opened.
*/
var PayloadError = class extends PairingError {
	constructor(message) {
		super("invalid-payload", `invalid pairing payload: ${message}`);
	}
};
function invalid(message) {
	throw new PayloadError(message);
}
/** Protocol `unicodeText`: a string carrying no lone UTF-16 surrogate. */
function isUnicodeText(value) {
	return !LONE_SURROGATE_RE$1.test(value);
}
function checkString(value, field, max) {
	if (typeof value !== "string") invalid(`payload field "${field}" must be a string`);
	if (value.length === 0) invalid(`payload field "${field}" must not be empty`);
	if (value.length > max) invalid(`payload field "${field}" exceeds ${max} characters`);
	if (!isUnicodeText(value)) invalid(`payload field "${field}" is not valid unicode text`);
	return value;
}
/**
* Normalizes one candidate host (ruling 2). The QR may carry IPv6 literals in
* bracketed form; the archive stores bare hosts and the connection layer adds
* brackets back when it builds the URL.
*
* WHATWG URL bracketing strips exactly the surrounding pair, so it is used
* only when the entry really is a bracketed literal — it would MISREAD a
* domain such as `[login.example.com]` as an IPv6 literal. A bracketed
* non-literal is therefore rejected rather than silently rewritten.
*/
function normalizeHost$1(raw) {
	if (raw.length > HOST_MAX$1) invalid(`payload host entry exceeds ${HOST_MAX$1} characters`);
	if (!(raw.startsWith("[") && raw.endsWith("]"))) return raw;
	const inner = raw.slice(1, -1);
	try {
		new URL(`http://${raw}/`);
	} catch {
		invalid(`payload host entry "${raw}" is not a valid IPv6 literal`);
	}
	return inner;
}
/**
* Parses and validates the pairing payload. Unknown fields are ignored (with a
* warning) — the payload carries host naming the design does not consume — but
* the fields on the manifest are judged against their protocol caps.
*/
function parsePayload(payload) {
	if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) invalid(`payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		invalid("payload is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("payload must be a JSON object");
	const raw = parsed;
	if (raw["v"] !== PAYLOAD_VERSION) invalid(`payload version must be ${PAYLOAD_VERSION}`);
	if (raw["t"] !== PAYLOAD_TYPE) invalid(`payload type must be "${PAYLOAD_TYPE}"`);
	const ignored = Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key));
	if (ignored.length > 0) console.warn(`[cherry-remote] pairing payload ignored unknown field(s): ${ignored.join(", ")}`);
	const port = raw["port"];
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) invalid("payload field \"port\" must be an integer in 1..65535");
	const ips = raw["ips"];
	if (!Array.isArray(ips) || ips.length === 0) invalid("payload field \"ips\" must be a non-empty array");
	const hosts = ips.map((entry, index) => normalizeHost$1(checkString(entry, `ips[${index}]`, HOST_MAX$1)));
	const invitationId = checkString(raw["invitationId"], "invitationId", OPAQUE_ID_MAX);
	const invitationSecret = checkString(raw["invitationSecret"], "invitationSecret", OPAQUE_ID_MAX);
	const desktopIdentity = checkString(raw["desktopIdentity"], "desktopIdentity", OPAQUE_ID_MAX);
	const versions = raw["protocolVersions"];
	if (!Array.isArray(versions) || versions.length === 0) invalid("payload field \"protocolVersions\" must be a non-empty array");
	return {
		hosts,
		port,
		invitationId,
		invitationSecret,
		desktopIdentity,
		protocolVersions: versions.map((version) => {
			if (typeof version !== "number" || !Number.isInteger(version)) invalid("payload field \"protocolVersions\" must contain integers");
			return version;
		})
	};
}
const DEFAULT_SUPPORTED_PROTOCOL_VERSIONS = [1];
const DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
const DEFAULT_POLL_INTERVAL_MS = 1e3;
/** The protocol invitationMs: 120s of invitation, and our poll race guard. */
const DEFAULT_POLL_TIMEOUT_MS = 12e4;
const VERIFICATION_CODE_RE = /^[0-9]{6}$/;
const noop = () => {};
/** A callable silent libp2p logger (same shape as the connection layer's). */
function makeSilentLogger() {
	const log = (() => {});
	log.error = noop;
	log.trace = noop;
	log.enabled = false;
	log.newScope = () => log;
	return log;
}
const silentComponentLogger = { forComponent: () => makeSilentLogger() };
function sleep$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Dials one candidate address and completes the Noise handshake.
*
* Both halves start concurrently (`Promise.all`): the peer's accept half is
* already running on its side, so a sequential dial would deadlock the
* prelude.
*
* `remoteIdentity` is REQUIRED by `connectSecureChannel` — it is what selects
* the outbound dialer half (without it the handshake waits for an inbound peer
* that will never come). It also makes the pairing's trust decision real
* rather than assumed: the payload's `desktopIdentity` is the peer the Noise
* XX handshake must prove, so a swapped-in impostor fails the handshake
* instead of being pinned as the desktop.
*/
async function dial(host, port, identity, desktopIdentity, protocolVersions, timeoutMs) {
	const ws = new WebSocket(`ws://${urlHost(host)}:${port}${remoteConnectPath}`);
	const controller = new AbortController();
	let timer;
	const timedOut = new Promise((_, reject) => {
		timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`connect to ${host}:${port} timed out`)), timeoutMs);
	});
	try {
		const connecting = (async () => {
			await new Promise((resolve, reject) => {
				ws.once("open", () => resolve());
				ws.once("error", (error) => reject(error));
			});
			const stream = new RemoteSocketStream(toRemoteSocket(ws), silentComponentLogger.forComponent("pairing"), "outbound");
			return connectSecureChannel(stream, {
				identity,
				logger: silentComponentLogger,
				protocolVersions: [...protocolVersions],
				signal: controller.signal,
				remoteIdentity: desktopIdentity
			});
		})();
		const channel = await Promise.race([connecting, timedOut.finally(() => controller.abort(/* @__PURE__ */ new Error("pairing connect timed out")))]);
		return {
			client: new JsonRpcClient(channel),
			channel,
			controller,
			ws
		};
	} catch (error) {
		controller.abort(error instanceof Error ? error : new Error(String(error)));
		ws.terminate();
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timer);
	}
}
/** Destroys a temporary channel: client, Noise channel, socket, abort signal. */
function destroy(temp) {
	temp.client.dispose();
	temp.channel.close().catch(noop);
	try {
		temp.ws.close();
	} catch {}
	temp.controller.abort();
}
function rpcReason(error) {
	if (error instanceof JsonRpcRequestError) {
		const data = error.data;
		if (data !== null && typeof data === "object" && typeof data.reason === "string") return data.reason;
	}
}
/**
* Pairs this DSH profile with a Cherry Studio desktop from its pairing payload,
* returning the PERSISTED record (ruling 6).
*
* Flow (spec §3.3): validate → try each candidate address on a fresh temporary
* channel → `pairing.claim` → surface the 6-digit code → poll `pairing.get`
* until the peer's terminal state → persist → destroy the channel.
*
* Claims are scoped to the claiming peer, so the whole lifecycle stays on ONE
* channel: a retry against a second candidate would be rejected as an
* already-claimed invitation, and it must not discard the code the user is
* already comparing on the desktop.
*
* Every failure throws {@link PairingError}: `invalid-payload` (payload),
* `rejected` / `expired` (the peer's terminal state), or `unreachable` (no
* candidate address produced a usable channel).
*/
async function pairWithPayload(opts) {
	const payload = parsePayload(opts.payload);
	const onStatus = opts.onStatus ?? noop;
	const report = (stage) => {
		console.info(`[cherry-remote] pairing stage ${stage} (hosts: ${payload.hosts.join(", ")})`);
		onStatus(stage);
	};
	report("validate");
	const supported = opts.supportedProtocolVersions ?? DEFAULT_SUPPORTED_PROTOCOL_VERSIONS;
	const offered = payload.protocolVersions.filter((version) => supported.includes(version));
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	report("connect");
	const failures = [];
	for (const host of payload.hosts) {
		let temp;
		try {
			temp = await dial(host, payload.port, opts.identity, payload.desktopIdentity, offered, connectTimeoutMs);
		} catch (error) {
			failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		try {
			const record = await claimAndAwait(temp.client, payload, offered, opts, report);
			destroy(temp);
			opts.store.upsert(record);
			return record;
		} catch (error) {
			destroy(temp);
			if (error instanceof PairingError) throw error;
			failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new PairingError("unreachable", `no candidate address could complete pairing (${failures.join("; ")})`);
}
/**
* The RPC half of one candidate: confirm the protocol, claim, present the code,
* poll to the terminal state. The approved branch is the ONLY source of
* deviceId, grants and token (ruling 3) — the claim receipt carries the code
* and nothing else.
*/
async function claimAndAwait(client, payload, protocolVersions, opts, onStatus) {
	const deviceName = (opts.name ?? hostname()).slice(0, DEVICE_NAME_MAX);
	try {
		await client.request("connection.hello", { protocolVersions: [...protocolVersions] });
	} catch (error) {
		throw asPairingError(error, "hello");
	}
	let claim;
	try {
		claim = await client.request("pairing.claim", {
			invitationId: payload.invitationId,
			invitationSecret: payload.invitationSecret,
			deviceName,
			platform: "desktop",
			capabilities: ["agent"]
		});
	} catch (error) {
		throw asPairingError(error, "claim");
	}
	if (typeof claim?.claimId !== "string" || !VERIFICATION_CODE_RE.test(claim.verificationCode ?? "")) throw new PairingError("unreachable", "peer returned a malformed pairing claim receipt");
	onStatus("claim");
	opts.onVerificationCode(claim.verificationCode);
	onStatus("waiting");
	const deadline = Date.now() + (opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
	const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	for (;;) {
		let result;
		try {
			result = await client.request("pairing.get", { claimId: claim.claimId });
		} catch (error) {
			throw asPairingError(error, "poll");
		}
		if (result.status === "rejected") throw new PairingError("rejected", "the desktop rejected this pairing request — verify that the 6-digit code shown on the desktop side matches the code this harness displayed, then generate a fresh pairing payload and try again");
		if (result.status === "expired") throw new PairingError("expired", "the pairing invitation has expired — regenerate the pairing code in Cherry Studio (the remote-access QR/payload) and retry");
		if (result.status === "approved") return recordFrom(payload, result, deviceName);
		if (Date.now() >= deadline) throw new PairingError("expired", "the pairing invitation expired while waiting for approval — regenerate the pairing code in Cherry Studio and retry");
		await sleep$1(interval);
	}
}
/**
* Builds the archived record from the approved branch (spec §3.2 field set).
*
* `displayName` is the name the claim actually carried — the record must not
* disagree with what the desktop shows for this device, and re-deriving it
* here would lose the 64-char truncation.
*/
function recordFrom(payload, approved, deviceName) {
	const grants = (approved.authorization?.grants ?? []).map((grant) => grant.domain).filter((domain) => domain === "agent");
	if (grants.length === 0) throw new PairingError("rejected", "the desktop approved no agent capability for this device");
	const tokenExpiresAt = Date.parse(approved.expiresAt);
	if (!Number.isFinite(tokenExpiresAt)) throw new PairingError("rejected", `the desktop approved the pairing with an unreadable token expiry (${JSON.stringify(approved.expiresAt)}); re-pair the device`);
	return {
		schemaVersion: 2,
		deviceId: approved.deviceId,
		displayName: deviceName,
		hosts: [...payload.hosts],
		port: payload.port,
		desktopIdentity: payload.desktopIdentity,
		grants,
		accessToken: approved.accessToken,
		tokenExpiresAt,
		enabled: true
	};
}
/**
* Maps a transport-level failure to the pairing error currency. A peer that
* answers a structured failure is reachable but unwilling: anything the claim
* or the poll can legitimately report (a stale invitation, a revoked claim)
* reads as `rejected`, while a dead channel means this address is unusable.
*/
function asPairingError(error, stage) {
	if (error instanceof PairingError) return error;
	const reason = rpcReason(error);
	if (reason !== void 0) return new PairingError("rejected", `the desktop refused the pairing ${stage} (${reason})`);
	return new PairingError("unreachable", `pairing ${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
}
//#endregion
//#region src/subscriptions.ts
/**
* Per-session event subscriptions over one connected device.
*
* Responsibilities (spec §3.5):
*   - lazily `agent.sessions.subscribe` a session on first use, with the last
*     known cursor so the peer can replay;
*   - buffer `agent.events` notifications per session and wake waiters
*     (Tasks 8/9 hang their `cherry_send(wait)` / `cherry_wait` resolvers here);
*   - advance the peer's view with `agent.subscriptions.ack`;
*   - keep the number of live subscriptions inside BOTH the peer-negotiated cap
*     and the local per-session byte budget, evicting LRU / dropping oldest;
*   - drive the checkpoint recovery chain when the peer cannot replay.
*
* The layer never reads the channel itself: `JsonRpcClient` owns the single
* read loop, and the assembly (Task 10) routes `rpc.onNotification` into
* {@link SessionSubscriptions.handleNotification}.
*/
/** The default peer subscription cap when the caller does not supply one. */
const DEFAULT_SUBSCRIPTIONS_LIMIT = 8;
/** The peer's prepared-lease window, used to bound recovery-chain retries. */
const DEFAULT_CHECKPOINT_MS = 3e5;
/**
* LOCAL POLICY CONSTANT (the protocol specifies no such bound; accepted by the
* controller as a defensive limit). The SHARED retry budget for one `ensure`:
* it covers BOTH recoverable paths — the `RESOURCE_EXHAUSTED` evict-and-retry
* and the checkpoint-lease-expiry chain restart — and is threaded down through
* the recovery recursion rather than counted per call, so a nested restart
* cannot reset it. Each retry is a FRESH subscribe + pagination + activate (a
* stale lease or stale pages are never reused), so this only bounds
* pathological peer churn: a peer that expires every lease surfaces its last
* error rather than looping forever. Not injectable — it is a safety bound,
* not a tuning knob.
*/
const MAX_RECOVERY_ATTEMPTS = 4;
function positive$1(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** The peer's failure discriminator, or undefined for a non-protocol error. */
function failureReason$1(error) {
	if (!(error instanceof JsonRpcRequestError)) return void 0;
	const data = error.data;
	return data !== null && typeof data === "object" && typeof data.reason === "string" ? data.reason : void 0;
}
/** UTF-8 byte length of one buffered event, as JSON (what the peer actually sends). */
function eventBytes(event) {
	try {
		return Buffer.byteLength(JSON.stringify(event), "utf8");
	} catch {
		return 64;
	}
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Validates the three cursor fields the protocol declares (all strings). */
function readCursor$1(value) {
	if (!isRecord$1(value)) return void 0;
	const { sessionId, streamEpoch, seq } = value;
	if (typeof sessionId !== "string" || typeof streamEpoch !== "string" || typeof seq !== "string") return void 0;
	return {
		sessionId,
		streamEpoch,
		seq
	};
}
var SessionSubscriptions = class {
	#rpc;
	/** Clamped to the peer-negotiated cap (see the class doc). */
	#limit;
	#perSessionCacheBytes;
	#checkpointMs;
	#sessions = /* @__PURE__ */ new Map();
	/**
	* Insertion order IS the eviction order, and it is SUBSCRIPTION recency, not
	* USE recency. Read that literally: only `ensure` (a re-subscribe re-inserts
	* the session at the MRU end) moves an entry. `read`, `ack`, `waitFor` and
	* every notification leave the order untouched — a session that is read
	* constantly but never re-subscribed is still the first eviction victim.
	*
	* That is a deliberate fit, not an oversight: the cap this LRU enforces is
	* the PEER's subscription cap, and the resource being rationed is the live
	* peer-side subscription. Sessions are long-lived and few (the cap defaults
	* to 8), so "least recently established" tracks the least valuable slot
	* closely enough; a true use-recency LRU would need a touch on every event
	* and would evict a session the caller is actively reading from.
	*/
	#closed = false;
	constructor(rpc, opts = {}) {
		this.#rpc = rpc;
		this.#limit = Math.max(1, Math.floor(positive$1(opts.subscriptionsLimit, DEFAULT_SUBSCRIPTIONS_LIMIT)));
		this.#perSessionCacheBytes = positive$1(opts.perSessionCacheBytes, DEFAULT_PER_SESSION_CACHE_BYTES);
		this.#checkpointMs = positive$1(opts.checkpointMs, DEFAULT_CHECKPOINT_MS);
	}
	/**
	* Session ids with a live subscription, LRU-first. Task 10's reconnect
	* re-ensure iterates exactly this list.
	*/
	activeSessions() {
		return [...this.#sessions.keys()];
	}
	/**
	* How many resolvers are currently parked on `sessionId`.
	*
	* A read-only view of state this layer owns, exposed because ABANDONED PARKS
	* are invisible otherwise: a caller that re-parks without disposing (the
	* `cherry_wait` poll loop) leaves one resolver per pass in the queue, and the
	* only symptom is a queue that grows silently. Zero for an untracked session.
	*/
	waiterCount(sessionId) {
		return this.#sessions.get(sessionId)?.waiters.length ?? 0;
	}
	/**
	* The session's CURRENT stream cursor — the newest position this layer knows
	* is durable for it — or undefined when the session is untracked.
	*
	* A READ-ONLY VIEW OF STATE THE LAYER ALREADY OWNS, and the reason it is a
	* public accessor rather than something each caller re-derives: two consumers
	* were reconstructing it from the outside, and both got it subtly wrong.
	*
	*  - `GET /diagnostics` used to report sessions with NO cursor at all, so the
	*    report claimed a subscription was live while omitting where it stood.
	*  - `cherry_events`' out-of-window verdict used to PROBE for the boundary by
	*    re-running `read` with candidate seqs. That probe could not even reach
	*    the answer in general (it scanned upward one seq at a time) and it made
	*    a read-only tool look like it was walking state.
	*
	* The window start is a DIFFERENT value and is exposed separately by
	* {@link windowStart} — this one is where the session's cursor stands, which
	* is what "resume from here" means.
	*/
	cursorOf(sessionId) {
		return this.#sessions.get(sessionId)?.cursor;
	}
	/**
	* The session's cache WINDOW START — the retention BOUNDARY of this layer's
	* cache: the oldest position it still tracks — or undefined when the session
	* is untracked.
	*
	* The boundary means two DIFFERENT things depending on whether the window has
	* dropped events (issue #2; see {@link SessionState.evicted}), which is why it
	* must not be described as "the earliest position you could resume from" in
	* one breath:
	*
	*  - NOTHING DROPPED — the boundary is the subscription's baseline, a position
	*    this layer itself issues as a resume point, and it IS the earliest
	*    resumable position: {@link read} serves it (the replay is the boundary
	*    INCLUSIVE here).
	*  - EVENTS DROPPED — the boundary is where the discarded run ended, and the
	*    event that occupied it is gone. The earliest resumable position is then
	*    the first retained event STRICTLY after it; the boundary itself is
	*    refused, and its value is what the refusal is judged against and what
	*    points a caller at the rebuild (`cherry_read`).
	*
	* So the reported value is exact as a rejection threshold and as a rebuild
	* anchor, and it must NOT be fed back to `read` in the dropped state — there
	* the verdict refuses it.
	*
	* Exposed because the layer is the only thing that knows it. Callers were
	* previously expected to rediscover it by binary-searching `read`'s verdict
	* from the outside, which is both wasteful and fragile: `read` also refuses
	* for a mismatched session/epoch, so a probe cannot distinguish "below the
	* window" from "wrong epoch" without more outside knowledge than a caller
	* should need.
	*/
	windowStart(sessionId) {
		const state = this.#sessions.get(sessionId);
		if (state === void 0) return void 0;
		return {
			sessionId,
			streamEpoch: state.cursor.streamEpoch,
			seq: String(state.windowStart)
		};
	}
	/**
	* Guarantees a live subscription for `sessionId`.
	*
	* The resume cursor comes from the CALLER or not at all — there is no
	* implicit reuse. Task 10's reconnect re-ensure passes the last cursor
	* explicitly; Tasks 8/9's first-use ensure is cursorless by design and may
	* therefore land in checkpoint mode.
	*
	* A same-session re-ensure is a SINGLE path: close the old peer subscription
	* FIRST (the peer flips it to `phase: 'reset'`, which is what makes the
	* re-subscribe legal rather than CONFLICT), then subscribe exactly once.
	*/
	async ensure(sessionId, cursor) {
		if (this.#closed) throw new Error("SessionSubscriptions disposed");
		const existing = this.#sessions.get(sessionId);
		if (existing !== void 0) {
			console.info(`[cherry-remote] re-subscribing session ${sessionId} (replacing its live subscription)`);
			await this.#closeSubscription(existing.subscriptionId);
			this.#rejectWaiters(existing, /* @__PURE__ */ new Error(`session ${sessionId} re-subscribed`));
			this.#sessions.delete(sessionId);
		}
		await this.#subscribeChain(sessionId, cursor);
	}
	/**
	* Reads buffered events newer than `fromCursor`.
	*
	* Returns `{ error: 'cursor-out-of-window' }` when the requested cursor is
	* strictly before the session's retention window start, or exactly AT it once
	* that boundary was advanced by dropping events (see {@link SessionState.evicted}).
	* Two positions reach the boundary, and they are NOT interchangeable:
	*
	*  - the subscription's BASELINE — where the window starts before anything was
	*    dropped. It is not an unretained event: it is the position this very
	*    layer hands out as the resume point (`#nextCursor` returns `state.cursor`
	*    when the buffer is empty, which on a fresh window IS the baseline), so
	*    serving it re-delivers exactly what the caller has not seen. Refusing it
	*    made the layer contradict itself: the cursor `cherry_send`/`cherry_wait`
	*    report and `cherry_events` must accept would have been rejected by this
	*    very method, and on a fresh session the two tools deadlocked (issue #2).
	*  - a boundary ADVANCED BY A DROP ({@link #trimToBudget}): the events that
	*    occupied that position are gone, so continuity cannot be proven. Serving
	*    it would return a correct-looking but possibly EMPTY replay whose
	*    `nextCursor` is that same unservable boundary, handing the caller a
	*    stale, empty read forever. Refusing routes them to `cherry_read`'s
	*    baseline rebuild instead, which is the only honest recovery.
	*
	* Anything strictly BEFORE the boundary is refused in both states (spec §3.6):
	* the layer never issued that position on this window, so it cannot vouch for
	* what happened at it.
	*/
	read(sessionId, fromCursor) {
		const state = this.#sessions.get(sessionId);
		if (state === void 0) return { error: "cursor-out-of-window" };
		if (fromCursor !== void 0) {
			if (fromCursor.sessionId !== sessionId || fromCursor.streamEpoch !== state.cursor.streamEpoch) return { error: "cursor-out-of-window" };
			const requested = Number(fromCursor.seq);
			const belowWindow = !Number.isFinite(requested) || requested < state.windowStart;
			const atDroppedBoundary = requested === state.windowStart && state.evicted;
			if (belowWindow || atDroppedBoundary) return { error: "cursor-out-of-window" };
			const threshold = requested;
			const events = state.buffer.filter((entry) => Number(entry.cursor.seq) > threshold).map((entry) => entry.event);
			return {
				events,
				nextCursor: this.#nextCursor(state, events.length)
			};
		}
		const events = state.buffer.map((entry) => entry.event);
		return {
			events,
			nextCursor: this.#nextCursor(state, events.length)
		};
	}
	/**
	* Routes one peer notification. `agent.events` fills the session buffer and
	* wakes waiters; `agent.subscriptions.resetRequired` marks the session for
	* re-subscription. Any other method is ignored with a warning — the client
	* layer deliberately delivers EVERY valid notification, so the consumer side
	* must tolerate methods it does not know.
	*/
	handleNotification(method, params) {
		if (method === "agent.events") {
			this.#onEvents(params);
			return;
		}
		if (method === "agent.subscriptions.resetRequired") {
			this.#onResetRequired(params);
			return;
		}
		console.warn(`[cherry-remote] ignoring unregistered notification "${method}"`);
	}
	/**
	* Advances the peer's view of this session: `agent.subscriptions.ack` with
	* the delivered cursor. The peer only accepts a cursor inside the window it
	* actually delivered (an out-of-window ack is its CONFLICT), so this is
	* called with the cursor a consumer has durably processed.
	*/
	async ack(sessionId, cursor) {
		const state = this.#sessions.get(sessionId);
		if (state === void 0) return;
		const applied = cursor ?? state.cursor;
		await this.#rpc.request("agent.subscriptions.ack", {
			subscriptionId: state.subscriptionId,
			cursor: applied
		});
	}
	/**
	* Parks a resolver that settles when the session buffer advances past
	* `cursor`. Tasks 8/9's waiters ride this; the wake is coalesced so a batch
	* of notifications wakes each waiter exactly once.
	*
	* Returns a DISPOSER alongside the promise. Without one, a caller that parks
	* repeatedly (the `cherry_wait` poll loop re-parks after every judgement pass)
	* leaves the previous park's resolver in the session's waiter queue forever:
	* the queue grows once per poll interval for the life of the wait, and every
	* buffer advance settles all of them. The disposer removes the park if it is
	* still queued; calling it after the park settled is a harmless no-op, so a
	* caller may use it unconditionally.
	*/
	waitFor(sessionId, cursor) {
		let dispose = () => {};
		return {
			promise: new Promise((resolve, reject) => {
				const state = this.#sessions.get(sessionId);
				if (state === void 0) {
					reject(/* @__PURE__ */ new Error(`no subscription for session ${sessionId}`));
					return;
				}
				const threshold = cursor === void 0 ? -Infinity : Number(cursor.seq);
				if ((state.buffer.length === 0 ? -Infinity : Number(state.buffer[state.buffer.length - 1].cursor.seq)) > threshold) {
					resolve();
					return;
				}
				const waiter = {
					resolve,
					reject
				};
				state.waiters.push(waiter);
				dispose = () => {
					const index = state.waiters.indexOf(waiter);
					if (index >= 0) state.waiters.splice(index, 1);
				};
			}),
			dispose
		};
	}
	/** Releases every live peer subscription (assembly teardown). */
	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		const ids = [...this.#sessions.values()].map((state) => state.subscriptionId);
		for (const state of this.#sessions.values()) {
			const error = /* @__PURE__ */ new Error("SessionSubscriptions disposed");
			for (const waiter of state.waiters.splice(0)) waiter.reject(error);
		}
		this.#sessions.clear();
		await Promise.all(ids.map((subscriptionId) => this.#closeSubscription(subscriptionId)));
	}
	/**
	* The ONE entry point that reaches the peer for a subscription, including
	* the full checkpoint recovery chain.
	*
	* A SINGLE shared budget governs every recoverable retry here — the
	* `RESOURCE_EXHAUSTED` evict-and-retry AND the checkpoint-lease-expiry chain
	* restart. `attemptsLeft` is threaded through the recursion (rather than
	* counted per call) precisely so a nested restart cannot reset the counter
	* and loop forever: a peer that expires every lease is eventually given up
	* on and its last `CHECKPOINT_EXPIRED` is surfaced.
	*/
	async #subscribeChain(sessionId, fromCursor, attemptsLeft = MAX_RECOVERY_ATTEMPTS) {
		for (;;) try {
			await this.#enforceLimitFor(sessionId);
			const descriptor = await this.#subscribe(sessionId, fromCursor);
			if (descriptor.mode === "replay") {
				this.#installReplay(sessionId, descriptor);
				return;
			}
			await this.#runCheckpointChain(sessionId, descriptor, attemptsLeft);
			return;
		} catch (error) {
			if (failureReason$1(error) === "RESOURCE_EXHAUSTED" && attemptsLeft > 1) {
				if (!await this.#evictLru(sessionId)) throw error;
				attemptsLeft -= 1;
				continue;
			}
			throw error;
		}
	}
	/** One `agent.sessions.subscribe`, classified into replay vs checkpoint. */
	async #subscribe(sessionId, fromCursor) {
		const params = fromCursor === void 0 ? { sessionId } : {
			sessionId,
			cursor: fromCursor
		};
		const result = await this.#rpc.request("agent.sessions.subscribe", params);
		const subscriptionId = result["subscriptionId"];
		if (typeof subscriptionId !== "string") throw new Error(`agent.sessions.subscribe returned no subscriptionId for ${sessionId}`);
		if (result["mode"] === "checkpoint") {
			const checkpoint = result["checkpoint"];
			const cursor = isRecord$1(checkpoint) ? readCursor$1(checkpoint["cursor"]) : void 0;
			if (!isRecord$1(checkpoint) || typeof checkpoint["checkpointId"] !== "string" || cursor === void 0) throw new Error(`agent.sessions.subscribe returned a malformed checkpoint descriptor for ${sessionId}`);
			return {
				mode: "checkpoint",
				subscriptionId,
				reason: typeof result["reason"] === "string" ? result["reason"] : "unspecified",
				checkpoint: {
					checkpointId: checkpoint["checkpointId"],
					cursor,
					historyRevision: String(checkpoint["historyRevision"] ?? ""),
					pageCount: typeof checkpoint["pageCount"] === "number" ? checkpoint["pageCount"] : 0,
					byteLength: String(checkpoint["byteLength"] ?? "0"),
					sha256: String(checkpoint["sha256"] ?? ""),
					expiresAt: String(checkpoint["expiresAt"] ?? "")
				}
			};
		}
		const cursor = readCursor$1(result["fromCursor"]);
		const highWatermark = readCursor$1(result["highWatermark"]);
		if (cursor === void 0 || highWatermark === void 0) throw new Error(`agent.sessions.subscribe returned a malformed replay descriptor for ${sessionId}`);
		return {
			mode: "replay",
			subscriptionId,
			fromCursor: cursor,
			highWatermark,
			leaseExpiresAt: String(result["leaseExpiresAt"] ?? "")
		};
	}
	/**
	* Installs a replay subscription: the peer will push events after the
	* requested cursor, so the buffer starts empty and the cursor is the
	* high-watermark the peer confirmed.
	*/
	#installReplay(sessionId, descriptor) {
		const previous = this.#sessions.get(sessionId);
		if (previous !== void 0) this.#rejectWaiters(previous, /* @__PURE__ */ new Error(`session ${sessionId} re-subscribed`));
		this.#sessions.delete(sessionId);
		this.#sessions.set(sessionId, {
			subscriptionId: descriptor.subscriptionId,
			cursor: descriptor.highWatermark,
			buffer: [],
			bytes: 0,
			windowStart: Number(descriptor.highWatermark.seq),
			evicted: false,
			waiters: [],
			projection: []
		});
		console.info(`[cherry-remote] subscription established for session ${sessionId} (replay from seq ${descriptor.fromCursor.seq}, high watermark ${descriptor.highWatermark.seq})`);
	}
	/**
	* The complete checkpoint recovery chain, run INSIDE the prepared lease the
	* subscribe descriptor opened:
	*
	*   1. `agent.checkpoints.read` paginates the projection rebuild — its
	*      `nextCursor` is a PAGINATION cursor and is used for nothing else;
	*   2. `agent.subscriptions.activate` commits `appliedCursor` taken from the
	*      subscribe DESCRIPTOR's cursor (all three fields).
	*
	* An expired lease (`CHECKPOINT_EXPIRED`) means the WHOLE chain is re-run:
	* a fresh subscribe, fresh pagination, fresh activate. A stale lease or
	* stale pages are never reused. A cursor mismatch is the peer's CONFLICT and
	* is surfaced, never swallowed.
	*
	* `attemptsLeft` is the SHARED budget handed down from {@link #subscribeChain}
	* and decremented on each lease-expiry restart, so a peer that expires every
	* lease terminates with its last error instead of restarting forever.
	*/
	async #runCheckpointChain(sessionId, descriptor, attemptsLeft) {
		const leaseDeadline = Date.now() + this.#checkpointMs;
		try {
			const items = await this.#readCheckpointPages(sessionId, descriptor);
			await this.#rpc.request("agent.subscriptions.activate", {
				subscriptionId: descriptor.subscriptionId,
				appliedCursor: descriptor.checkpoint.cursor
			});
			this.#installCheckpoint(sessionId, descriptor, items);
			return;
		} catch (error) {
			if (!(failureReason$1(error) === "CHECKPOINT_EXPIRED" || Date.now() > leaseDeadline) || attemptsLeft <= 1) throw error;
			await this.#closeSubscription(descriptor.subscriptionId);
			await this.#subscribeChain(sessionId, void 0, attemptsLeft - 1);
			return;
		}
	}
	/**
	* Paginates `agent.checkpoints.read` to completion, returning every item.
	* Only the pagination cursor advances here.
	*/
	async #readCheckpointPages(sessionId, descriptor) {
		const items = [];
		let pageCursor;
		for (let page = 0;; page += 1) {
			const params = {
				subscriptionId: descriptor.subscriptionId,
				checkpointId: descriptor.checkpoint.checkpointId
			};
			if (pageCursor !== void 0) params["pageCursor"] = pageCursor;
			const result = await this.#rpc.request("agent.checkpoints.read", params);
			const pageItems = result["items"];
			if (Array.isArray(pageItems)) {
				for (const item of pageItems) if (isRecord$1(item) && typeof item["kind"] === "string") items.push({
					kind: item["kind"],
					value: item["value"]
				});
			}
			const next = result["nextCursor"];
			if (next === null || next === void 0) return items;
			pageCursor = String(next);
			if (page >= 1e4) throw new Error(`checkpoint pagination for ${sessionId} did not terminate`);
		}
	}
	/**
	* Installs the recovered subscription. The checkpoint's cursor becomes the
	* session baseline and the recovered projection items are retained as
	* {@link SessionState.projection} — they are STATE, not stream events, so
	* they never enter the event buffer and never carry a stream cursor. The
	* buffer starts empty because activation releases the replay suffix; only
	* events arriving after this baseline are streamed.
	*/
	#installCheckpoint(sessionId, descriptor, items) {
		const previous = this.#sessions.get(sessionId);
		if (previous !== void 0) this.#rejectWaiters(previous, /* @__PURE__ */ new Error(`session ${sessionId} recovered`));
		this.#sessions.delete(sessionId);
		this.#sessions.set(sessionId, {
			subscriptionId: descriptor.subscriptionId,
			cursor: descriptor.checkpoint.cursor,
			buffer: [],
			bytes: 0,
			windowStart: Number(descriptor.checkpoint.cursor.seq),
			evicted: false,
			waiters: [],
			projection: [...items]
		});
		console.info(`[cherry-remote] subscription recovered for session ${sessionId} from checkpoint ${descriptor.checkpoint.checkpointId} (baseline seq ${descriptor.checkpoint.cursor.seq}, ${items.length} projection item(s))`);
	}
	/**
	* The projection state rebuilt from a checkpoint for `sessionId`, in the
	* order the pages delivered it, or an empty array when the session holds no
	* recovered baseline. Consumers (Task 9's `cherry_read`, Task 8's baseline)
	* read the rebuilt state through this rather than through the event buffer.
	*/
	projection(sessionId) {
		return this.#sessions.get(sessionId)?.projection ?? [];
	}
	async #closeSubscription(subscriptionId) {
		try {
			await this.#rpc.request("agent.subscriptions.close", { subscriptionId });
		} catch (error) {
			console.warn(`[cherry-remote] closing subscription ${subscriptionId} failed`, error);
		}
	}
	/**
	* Makes room for one more peer subscription when the live count has reached
	* the CLAMPED cap, by evicting the least-recently-used session other than
	* `protectedSessionId`. The close is AWAITED (controller ruling 1): the peer
	* frees its slot only once it has processed `agent.subscriptions.close`, so a
	* fire-and-forget eviction would race the next subscribe straight into
	* RESOURCE_EXHAUSTED. Returns false when there was nothing to evict.
	*/
	async #enforceLimitFor(protectedSessionId) {
		if (this.#liveCount() < this.#limit) return;
		await this.#evictLru(protectedSessionId);
	}
	/**
	* Evicts the least-recently-used live session other than `protectedSessionId`,
	* unconditionally (no local-cap precondition). This is the RESOURCE_EXHAUSTED
	* reaction: the peer's REAL cap turned out to be below the advertised one, so
	* a slot must be freed regardless of what the local cap believed.
	*/
	async #evictLru(protectedSessionId) {
		for (const [sessionId, state] of this.#sessions) {
			if (sessionId === protectedSessionId) continue;
			console.warn(`[cherry-remote] subscription limit (${this.#limit}) reached; evicting least-recently-used session ${sessionId}`);
			this.#rejectWaiters(state, /* @__PURE__ */ new Error(`session ${sessionId} evicted by LRU`));
			this.#sessions.delete(sessionId);
			await this.#closeSubscription(state.subscriptionId);
			return true;
		}
		return false;
	}
	/** Live (peer-backed) subscription count — every entry is live. */
	#liveCount() {
		return this.#sessions.size;
	}
	/**
	* `agent.events`: append to the session buffer, enforce the byte budget by
	* dropping the OLDEST events (logged), advance the cursor, then wake waiters.
	*
	* SEQ MONOTONICITY IS ENFORCED HERE, per (sessionId, streamEpoch). The peer is
	* supposed to deliver each stream position exactly once and in order, and the
	* layer's whole contract — `nextCursor`, `windowStart`, the waiter predicate —
	* is expressed in terms of a cursor that only ever moves FORWARD. A duplicate
	* or out-of-order batch (a replay race across a reconnect, a peer retry)
	* would otherwise:
	*
	*  - move `state.cursor` BACKWARDS, so `read()`'s `nextCursor` regresses and a
	*    caller resuming from it re-consumes events it already acked;
	*  - append an event the caller has already seen, duplicating history;
	*  - `#wakeWaiters` for a "new" event that is not new, so a parked waiter
	*    re-judges state the caller has already processed.
	*
	* A NON-INCREASING seq is therefore refused with a warning (never silently),
	* and — importantly — a batch that is wholly stale does not wake anyone. A
	* batch that arrives with a mix is filtered event by event, so genuine
	* progress inside the same notification is never lost. `windowStart` is not
	* touched either: the position an event occupied is not being un-retained.
	*/
	#onEvents(params) {
		if (!isRecord$1(params)) {
			console.warn("[cherry-remote] ignoring malformed agent.events notification");
			return;
		}
		const subscriptionId = params["subscriptionId"];
		const sessionId = params["sessionId"];
		const streamEpoch = params["streamEpoch"];
		const events = params["events"];
		if (typeof subscriptionId !== "string" || typeof sessionId !== "string" || !Array.isArray(events)) {
			console.warn("[cherry-remote] ignoring malformed agent.events notification");
			return;
		}
		const state = this.#sessions.get(sessionId);
		if (state === void 0 || state.subscriptionId !== subscriptionId) return;
		if (streamEpoch !== void 0 && typeof streamEpoch !== "string") {
			console.warn(`[cherry-remote] ignoring agent.events for session ${sessionId}: stream epoch is ${JSON.stringify(streamEpoch)} (${typeof streamEpoch}), not a string; refusing to treat a malformed epoch as the current one`);
			return;
		}
		if (typeof streamEpoch === "string" && streamEpoch !== state.cursor.streamEpoch) {
			console.warn(`[cherry-remote] ignoring agent.events for session ${sessionId}: stream epoch ${streamEpoch} does not match ${state.cursor.streamEpoch}`);
			return;
		}
		let appended = 0;
		for (const raw of events) {
			if (!isRecord$1(raw)) continue;
			const seq = String(raw["seq"] ?? "");
			if (seq === "") continue;
			const arrived = Number(seq);
			const current = Number(state.cursor.seq);
			if (!Number.isFinite(arrived) || Number.isFinite(current) && arrived <= current) {
				console.warn(`[cherry-remote] ignoring out-of-order agent.events for session ${sessionId}: seq ${seq} is not newer than the stream cursor ${state.cursor.seq}; the session cursor never regresses`);
				continue;
			}
			const cursor = {
				sessionId,
				streamEpoch: state.cursor.streamEpoch,
				seq
			};
			const event = raw;
			const bytes = eventBytes(event);
			state.buffer.push({
				cursor,
				event,
				bytes
			});
			state.bytes += bytes;
			state.cursor = cursor;
			appended += 1;
		}
		this.#trimToBudget(sessionId, state);
		if (appended > 0) this.#wakeWaiters(state);
	}
	/**
	* `agent.subscriptions.resetRequired`: the peer tore the subscription down
	* (replay suffix lost, checkpoint lease lapsed, ...). The session is dropped
	* entirely — there is nothing to reuse, so the caller's next `ensure` must
	* rebuild it from a FRESH subscribe (and, cursorless, will land in checkpoint
	* mode). ⑤ pins this behaviour as intended.
	*/
	#onResetRequired(params) {
		if (!isRecord$1(params)) {
			console.warn("[cherry-remote] ignoring malformed agent.subscriptions.resetRequired notification");
			return;
		}
		const subscriptionId = params["subscriptionId"];
		if (typeof subscriptionId !== "string") return;
		for (const [sessionId, state] of this.#sessions) {
			if (state.subscriptionId !== subscriptionId) continue;
			console.warn(`[cherry-remote] subscription for session ${sessionId} reset by the peer (${String(params["reason"] ?? "unspecified")}); re-subscribe required`);
			this.#rejectWaiters(state, /* @__PURE__ */ new Error(`session ${sessionId} reset by the peer`));
			this.#sessions.delete(sessionId);
			return;
		}
	}
	/** Drops the OLDEST buffered events until the session fits its byte budget. */
	#trimToBudget(sessionId, state) {
		if (state.bytes <= this.#perSessionCacheBytes) return;
		let dropped = 0;
		while (state.bytes > this.#perSessionCacheBytes && state.buffer.length > 0) {
			const removed = state.buffer.shift();
			state.bytes -= removed.bytes;
			dropped += 1;
			state.windowStart = Math.max(state.windowStart, Number(removed.cursor.seq));
			state.evicted = true;
		}
		console.warn(`[cherry-remote] session ${sessionId} cache exceeded ${this.#perSessionCacheBytes} bytes; dropped ${dropped} oldest event(s)`);
	}
	/** Coalesced wake: each parked waiter settles exactly once. */
	#wakeWaiters(state) {
		for (const waiter of state.waiters.splice(0)) waiter.resolve();
	}
	#rejectWaiters(state, error) {
		for (const waiter of state.waiters.splice(0)) waiter.reject(error);
	}
	/** The cursor a read advances to: the newest event returned, else the cursor. */
	#nextCursor(state, returnedCount) {
		if (returnedCount === 0) return state.cursor;
		return state.buffer[state.buffer.length - 1].cursor;
	}
};
//#endregion
//#region src/tools.ts
/** The four terminal execution statuses the waiter predicate covers. */
const TERMINAL_EXECUTION_STATUSES = [
	"completed",
	"failed",
	"cancelled",
	"interrupted"
];
/** The protocol's single-page hard cap, used only as the pre-hello ceiling. */
const PAGE_ITEMS_FALLBACK = 100;
/** The largest MESSAGE aggregate a caller may ask for; the per-page clamp still applies. */
const MAX_AGGREGATE_LIMIT = 1e3;
/**
* MESSAGE CEILING for the terminal/timeout/idle aggregate (issue #3).
*
* These three results are answers to a WAIT, not listings: the caller asked
* "what did my run produce?" and the walk exists to find the run's own
* messages. Reading the session's whole history to answer that was the field
* defect — a 459-message session meant 29+ `agent.messages.list` pages plus
* every part of every message, i.e. 118-124 s of round trips AFTER the
* deadline had already elapsed.
*
* 20 is not a guess about how much history a caller might like: one run
* persists a user message and an assistant message (a pair), and the peer's
* `listSessionMessages` walks NEWEST-FIRST, so the walk reaches the run's own
* messages FIRST. Ten runs' worth of slack is therefore already an order of
* magnitude more than the walk needs to see the current one.
*
* Truncation is SURFACED (`messagesTruncated` + reason + resume cursor), never
* silent: a caller that really wants the deeper history resumes from the
* cursor or reads the session with `cherry_read`, whose own `limit` is the
* caller's to raise.
*/
const TERMINAL_AGGREGATE_MESSAGES = 20;
/**
* BYTE BUDGET for the terminal/timeout/idle aggregate, applied to the
* PROJECTED messages (each one after `#projectMessage`, measured with
* `JSON.stringify`'s length as a cheap approximation of its wire cost).
*
* The message ceiling alone does not bound the RESULT: one message can carry
* hundreds of parts, each an externalized `{ref}` resolved through a separate
* `agent.content.read`. The field report's aggregate was 13 MB across 459
* messages, and a result that size does not survive the MCP boundary at all
* ("value is not lossless JSON") — the caller loses the verdict along with the
* content. 256 KiB is a deliberate fraction of a tool result: enough for a
* long reply plus its reasoning, small enough to stay well inside the limit.
*
* THE NEWEST MESSAGE IS ALWAYS WHOLE. The budget is checked only AFTER a
* message's projection completes, and the first message is always taken before
* any check runs — it is the run's own reply, so a budget that could truncate
* it would defeat the purpose of reading the history in the first place.
*/
const TERMINAL_AGGREGATE_BYTES = 262144;
/**
* What a caller whose terminal aggregate could not be assembled should do.
*
* The assembly failure is a CONTENT problem (an unverifiable `{ref}`, a part
* walk the peer would not terminate, a message list that moved under us), not
* a verdict on the run: the run's status is already known and is still true.
* Saying so — and naming the route that rebuilds the content without a wait —
* is what keeps the caller from re-running a command whose outcome is settled.
*/
const AGGREGATE_FAILED_GUIDANCE = "content assembly failed; the run verdict stands — use cherry_read to fetch the messages";
/** One `agent.content.read` slice is capped at the protocol's `remoteLimits.contentBytes`. */
const CONTENT_READ_MAX_BYTES = 24576;
/**
* CIRCUIT-BREAKER for the parts walk (a local policy bound, NOT a protocol
* limit — the protocol caps nothing at 1000 parts). A message's parts are read
* to COMPLETION, so this exists only to stop a peer that never terminates its
* pagination. Tripping it is SURFACED (`partsTruncated` + `partsResumeCursor`),
* never silent, so a caller can always tell a complete part list from a
* circuit-broken one. Injectable for tests.
*/
const DEFAULT_PARTS_SAFETY_BOUND = 1e4;
/**
* PAGE-COUNT BACKSTOP for every aggregate walk, alongside the item ceiling.
*
* The item ceiling alone cannot stop a peer that answers `items: []` with a
* non-null `nextCursor`: the item count never grows, so a bound expressed only
* in items is never reached. This is a peer fault, and a walk that hits it
* FAILS — an empty page that claims more are coming is never a reason to return
* a partial (or empty) result as though it were complete.
*/
const MAX_AGGREGATE_PAGES = 1e4;
/**
* CIRCUIT-BREAKER for one `{ref}`'s content walk, used only when the ref
* carries no usable `byteLength`. The ref's declared length normally derives
* the bound exactly; this is the fallback for a malformed ref, and exceeding it
* FAILS the read rather than returning a partial (unverifiable) content.
*/
const DEFAULT_CONTENT_SLICE_BOUND = 4096;
/** The protocol's `agent.messages.send.text` ceiling, pre-validated tool-side. */
const TEXT_MAX_LENGTH = 32768;
/** The default wait window, in ms (spec §3.6). A default, never a cap. */
const DEFAULT_WAIT_TIMEOUT_MS = 12e4;
/** The smallest meaningful timeout: below this the wait is a snapshot read. */
const MIN_WAIT_TIMEOUT_MS = 1;
/**
* POLL CADENCE for the waiter loop.
*
* The waiter rides the subscriptions layer's event buffer, which exposes a
* cursor-gated `waitFor` rather than a predicate hook, so the run is judged by
* re-reading the projection after each wake. This constant only bounds how long
* a wait may sit between two judgement passes when the peer has gone quiet, so
* a missed wake degrades into a slightly late answer instead of a hang. It is
* injectable for tests.
*/
const DEFAULT_WAIT_POLL_MS = 25;
/**
* What a caller whose wait lost its event stream should do next.
*
* Reached only when the re-ensure itself could not be completed, so the run's
* outcome genuinely cannot be observed from here. The instruction names the two
* routes that DO work — the read face does not depend on the subscription, and
* a later `cherry_wait` rebuilds one from scratch — because "subscription lost"
* without a next step is a dead end for the caller.
*/
const SUBSCRIPTION_LOST_GUIDANCE = "the session's event subscription was lost mid-wait and could not be re-established; the run's outcome is unknowable from this wait. Read the session with cherry_read (it does not need a subscription), or call cherry_wait again to rebuild the subscription from a fresh baseline";
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The peer's failure discriminator, or undefined for a non-protocol error. */
function failureReason(error) {
	if (!(error instanceof JsonRpcRequestError)) return void 0;
	const data = error.data;
	if (isRecord(data) && typeof data["reason"] === "string") return data["reason"];
}
/**
* One `{ref}`'s content could not be TRUSTED: the bytes served do not match the
* digest the ref advertises (or there was no digest to check against).
*
* A class rather than a message, because the callers act on the difference: a
* single unreadable part degrades to `unavailable` (see
* {@link CherryToolEngine} `#projectPart`), while an integrity failure must
* fail the WHOLE read — content that cannot be verified must never be reported
* as though it were complete. Matching on message text would break silently the
* first time the wording changed.
*/
var ContentIntegrityError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ContentIntegrityError";
	}
};
/**
* Why one part's text is missing, as the `unavailable` field reports it.
*
* The peer's own reason is preferred (`NOT_FOUND`, `RESOURCE_EXHAUSTED`, ...)
* because it is the actionable half; an error with no protocol reason falls
* back to its message. Bounded so a peer-echoed string cannot inflate a tool
* result.
*/
function unavailableReason(error) {
	const reason = failureReason(error);
	if (reason !== void 0) return reason;
	return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
/**
* The §6 recovery advice appended to the peer's `IDEMPOTENCY_CONFLICT`.
*
* The peer refused a `commandId` that is already in its ledger under a
* DIFFERENT body. That is not a transient failure and must never be retried
* as-is: the id is the identity of the command, so re-sending the changed body
* under it will be refused forever. The recovery is to REGENERATE the id for
* the new body (or re-send the ORIGINAL body to replay the original outcome).
*/
const IDEMPOTENCY_HINT = "the peer already recorded this commandId with a different body; regenerate the commandId for a retry whose parameters changed — never reuse an id with a different body (re-send the ORIGINAL body to replay the original receipt).";
/**
* Passes a command failure through UNCHANGED, except that `IDEMPOTENCY_CONFLICT`
* gets {@link IDEMPOTENCY_HINT} appended to its message.
*
* The error object itself is NOT replaced: the reason, the structured `data`
* and the {@link JsonRpcRequestError} identity all survive, so a caller that
* branches on the reason (and the existing suites that assert it) see exactly
* what the peer sent. Only `message` — the human-readable half — is extended.
* Mutating in place is deliberate: a re-wrap would cost the prototype and with
* it every `instanceof` check downstream.
*/
function withIdempotencyHint(error) {
	if (!(error instanceof Error)) return error;
	if (failureReason(error) !== "IDEMPOTENCY_CONFLICT") return error;
	if (error.message.includes(IDEMPOTENCY_HINT)) return error;
	error.message = `${error.message} — ${IDEMPOTENCY_HINT}`;
	return error;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* The peer's `agent.messages.send` refusal for a STALE `expectedIdleRevision`,
* in the exact shape Cherry Studio answers it: a `rejected` receipt whose
* `error` is `{reason: 'CONFLICT', message: 'Session is not idle at the
* expected revision'}` (a throw inside the handler's `startRun` guard, folded
* into a receipt by its `command()` wrapper).
*
* Deliberately NOT "any CONFLICT": two other CONFLICT refusals share the
* reason and mean something entirely different —
*
*  - "Session is busy" says a run is in flight. The revision is moot, and a
*    retry would change nothing; retrying it would spend a command per call
*    on a session that is working normally.
*  - "Execution is not active" belongs to the cancel verb, not to this one.
*
* The message match is what separates them, so this predicate keys on the
* message the peer actually sends rather than on the reason alone.
*/
function isStaleRevisionRefusal(receipt) {
	if (receipt["status"] !== "rejected") return false;
	const error = isRecord(receipt["error"]) ? receipt["error"] : void 0;
	if (error === void 0 || error["reason"] !== "CONFLICT") return false;
	const message = error["message"];
	return typeof message === "string" && message.includes(SEND_STALE_REVISION_MESSAGE);
}
/** The peer's exact wire文案 for a stale admission baseline (see above). */
const SEND_STALE_REVISION_MESSAGE = "not idle at the expected revision";
function requiredString(args, key) {
	const value = args[key];
	if (typeof value !== "string" || value === "") throw new Error(`cherry tools: "${key}" is required and must be a non-empty string`);
	return value;
}
/** One text block: the tool result the model reads. */
function textBlock(text) {
	return [{
		type: "text",
		text
	}];
}
/** The read tools' canonical output contract: whatever the tool declared. */
const FREE_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: true
};
/** A generous, honest renderer: the model gets the whole aggregated value as JSON. */
function jsonRender(_args, value) {
	return textBlock(JSON.stringify(value, null, 2));
}
/**
* The 14 `cherry_*` tool names, in the family's documented order.
*
* THE one list: the plugin assembly (`src/index.ts` hands it to the scope host
* as `names`, which is where the visibility `deny` sets and the dispatch
* guard's scope come from) and the contract suite read this constant instead of
* keeping a copy of their own. The diagnostics face does NOT read it — its
* scope segment reports the live scope state, not this list.
*
* {@link CherryToolEngine.definitions()} still spells each name inside its own
* declaration — that literal is what the host registry receives — so the two
* CAN drift. The contract suite's bidirectional-difference assertion is the
* interceptor: a tool added, renamed or dropped on either side turns red
* instead of leaving the published list silently wrong.
*/
const CHERRY_TOOL_NAMES = [
	"cherry_devices",
	"cherry_agents",
	"cherry_workspaces",
	"cherry_sessions",
	"cherry_read",
	"cherry_events",
	"cherry_create",
	"cherry_send",
	"cherry_wait",
	"cherry_interactions",
	"cherry_respond",
	"cherry_cancel",
	"cherry_pair",
	"cherry_unpair"
];
/**
* Registers the whole `cherry_*` family on `ctx.tools` — exactly the names in
* {@link CHERRY_TOOL_NAMES}, which the contract suite asserts against this
* function's own registrations.
*
* The registration framework is deliberately thin because Tasks 9/10 extend it:
* {@link defineCherryTool} is the ONE place a tool declaration is assembled, so
* those tasks add mutating tools without touching the host seam.
*/
function registerCherryTools(ctx, deps, options = {}) {
	const tools = ctx.tools;
	if (tools === void 0) {
		console.warn("[cherry-remote] ctx.tools is unavailable; the cherry_* tools were not registered");
		return () => {};
	}
	const disposers = new CherryToolEngine(deps, options).definitions().map((definition) => tools.register(definition));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** One tool declaration, in the exact shape the host registry consumes. */
function defineCherryTool(definition) {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		output: {
			schema: FREE_OUTPUT_SCHEMA,
			render: jsonRender
		},
		execute: definition.execute
	};
}
/**
* The six read tools — and, below them, the WHOLE fourteen-tool `cherry_*`
* family: the six READ-ONLY tools (Task 8), six INTERACTIVE ones (Task 9), and
* two MANAGEMENT ones (Task 10), plus the registration framework they all
* share. Kept as one class (rather than per-face closures) so the per-session
* and per-device state the later faces add has an obvious home.
*/
var CherryToolEngine = class {
	#deps;
	/**
	* Circuit-breaker for the parts walk. A LOCAL policy value, injectable so a
	* test can drive the bound low enough to prove that tripping it SURFACES
	* rather than silently truncating.
	*/
	#partsSafetyBound;
	/** Poll cadence for the interactive waiters (see `DEFAULT_WAIT_POLL_MS`). */
	#waitPollMs;
	/**
	* The subscription cache's latest IDLE revision per `<deviceId>\0<sessionId>`
	* — the source of `agent.messages.send`'s `expectedIdleRevision` (spec §4.2).
	* A cold cache is baselined from `agent.sessions.get`, so the value sent is
	* always one the peer itself reported.
	*
	* The DEVICE component is load-bearing: this engine is one instance shared by
	* every device in the pool, while a session id belongs to a peer. See
	* {@link CherryToolEngine.#cacheKey}.
	*/
	#revisionCache = /* @__PURE__ */ new Map();
	/**
	* The subscription cache's current ACTIVE execution per `<deviceId>\0
	* <sessionId>` — ONE source shared by `cherry_cancel`'s `expectedExecutionId`
	* and `cherry_respond`'s staleness triple, so the two can never disagree
	* about what is running. Device-scoped for the same reason as
	* {@link CherryToolEngine.#revisionCache}: execution ids are the peer's, and
	* a bare-sessionId key would let one desktop name another's run.
	*/
	#executionCache = /* @__PURE__ */ new Map();
	/**
	* The subscription cache's interaction snapshots, keyed `<deviceId>\0<sessionId>\0
	* <interactionId>`: the `expectedRevision`/`expectedExecutionId`/
	* `inputDigest` triple `cherry_respond` sends.
	*
	* AUTHORITY (adjudicated): `agent.interactions.list` is the AUTHORITATIVE
	* source for respond-eligibility snapshots — it is the peer's persisted,
	* four-state view, and it is the path that makes a card the peer never
	* streamed answerable at all. The real-time `interaction.updated` stream is
	* an ACCELERATOR/FRESHENER: it refreshes this cache without a round trip, so
	* the common case answers instantly, but nothing here may treat "not
	* streamed" as "not answerable". {@link CherryToolEngine.#interactionSnapshot}
	* implements exactly that order: fold the stream in first, then fall back to
	* ONE list query.
	*/
	#interactionCache = /* @__PURE__ */ new Map();
	constructor(deps, options = {}) {
		this.#deps = deps;
		this.#partsSafetyBound = Math.max(1, Math.floor(options.partsSafetyBound ?? DEFAULT_PARTS_SAFETY_BOUND));
		this.#waitPollMs = Math.max(1, Math.floor(options.waitPollMs ?? DEFAULT_WAIT_POLL_MS));
	}
	definitions() {
		return [
			this.#devicesTool(),
			this.#agentsTool(),
			this.#workspacesTool(),
			this.#sessionsTool(),
			this.#readTool(),
			this.#eventsTool(),
			this.#createTool(),
			this.#sendTool(),
			this.#waitTool(),
			this.#interactionsTool(),
			this.#respondTool(),
			this.#cancelTool(),
			this.#pairTool(),
			this.#unpairTool()
		];
	}
	/**
	* Resolves `device` to a live connection, or returns the structured verdict
	* the caller must report. Ambiguity is NOT an error throw (controller ruling
	* ⑤): the candidate list is the answer.
	*/
	#resolve(device) {
		const resolution = this.#deps.store.resolve(device);
		if ("ambiguous" in resolution) return {
			error: "ambiguous-device",
			device,
			candidates: resolution.ambiguous
		};
		const connection = this.#deps.connect(resolution.deviceId);
		if (connection.state !== "connected") return {
			error: "device-unavailable",
			device: resolution.deviceId,
			state: connection.state
		};
		return {
			record: resolution,
			connection
		};
	}
	/**
	* The quarantined-archive verdict, or `undefined` for a healthy store.
	*
	* Consulted BEFORE any resolution, because a quarantined store's empty view
	* makes every downstream answer a lie: `resolve` cannot find a device that IS
	* paired (the archive is unreadable), so it reports ambiguity with no
	* candidates, and a caller reasonably concludes the device is not paired —
	* about a store that still holds its access token on disk. The probe is a
	* cheap readonly field read on the store, and it is deliberately checked on
	* every device-dependent entry point rather than once at registration: the
	* archive can go bad while the process is running.
	*/
	#quarantineVerdict() {
		const info = this.#deps.store.quarantineInfo();
		if (info === void 0) return void 0;
		return {
			error: "archive-quarantined",
			guidance: QUARANTINE_RECOVERY,
			archive: info.file,
			...info.corruptPath === void 0 ? {} : { preservedAs: info.corruptPath }
		};
	}
	/** True when `#resolve` answered with a structured verdict instead of a link. */
	#isVerdict(resolved) {
		return "error" in resolved;
	}
	/**
	* Resolve-or-verdict: every non-`cherry_devices` tool needs a live link.
	*
	* The two failure faces are deliberately DIFFERENT (controller ruling ⑤):
	* an ambiguous selector is an ANSWER — the structured candidate list is
	* returned in band, because the caller can act on it — while a non-connected
	* device is the §6 `DeviceUnavailableError` the established error face
	* already defines.
	*/
	#requireConnection(device) {
		const resolved = this.#resolve(device);
		if (!this.#isVerdict(resolved)) return resolved;
		if (resolved.error === "ambiguous-device") return resolved;
		throw new DeviceUnavailableError(resolved.device, resolved.state);
	}
	/**
	* The connection-plus-record pair, or the ambiguous verdict to return
	* verbatim. Lets each tool's body read as `resolved.link ?? resolved.verdict`
	* without repeating the discriminant dance.
	*
	* The quarantine check comes FIRST: it is the strongest statement available
	* (the device set itself is unknowable), and letting resolution run would
	* replace it with a weaker, wrong one.
	*/
	#linkOr(device) {
		const quarantined = this.#quarantineVerdict();
		if (quarantined !== void 0) return { verdict: quarantined };
		const resolved = this.#requireConnection(device);
		if ("error" in resolved) return { verdict: resolved };
		return { link: resolved };
	}
	/**
	* Walks pages until `limit` items are collected or the peer runs out,
	* clamping EVERY page to the byte-safe page budget.
	*
	* TWO clamps bound every page request. `limits.pageItems` is the
	* peer-negotiated COUNT cap (the protocol's single-page hard limit, whatever
	* the caller asks for), and `maxPerPage` is the plugin's own WIRE-SAFETY
	* clamp: one JSON-RPC record may not exceed `remoteLimits.recordBytes`
	* (64 KiB), the desktop's `pageOf` budgets pages by count alone, and a page
	* of fat inline items is a record the transport answers by killing the
	* connection. The clamps live in `defaults.ts` with their derivation; the
	* effective page size is whichever of the two is smaller.
	*
	* `limit` is a CALLER contract, and reaching it is reported as
	* `truncationReason: 'limit'`. `safetyBound` is different in kind: it is an
	* internal circuit-breaker against a peer that never terminates, and tripping
	* it is ALWAYS surfaced (`truncationReason: 'safety-bound'` plus the resume
	* cursor) — a walk never stops early and reports success.
	*
	* A peer that answers empty pages with a non-null `nextCursor` is a FAULT,
	* not a slow walk: no item ceiling can ever be reached, so it is detected
	* directly and thrown (see {@link MAX_AGGREGATE_PAGES} for the backstop).
	*/
	async #aggregate(connection, method, params, extract, limit, safetyBound = MAX_AGGREGATE_LIMIT, maxPerPage = 16) {
		const negotiated = Math.max(1, Math.floor(connection.limits.pageItems || PAGE_ITEMS_FALLBACK));
		const pageItems = Math.min(negotiated, Math.max(1, Math.floor(maxPerPage)));
		const aggregate = Math.max(1, Math.floor(limit));
		const bound = Math.max(1, Math.floor(safetyBound));
		const ceiling = Math.min(aggregate, bound);
		const bindsCallerLimit = aggregate < bound;
		const items = [];
		let cursor;
		for (let pages = 0;; pages += 1) {
			if (items.length >= ceiling) return this.#truncated(items, bindsCallerLimit ? "limit" : "safety-bound", cursor);
			if (pages >= MAX_AGGREGATE_PAGES) throw new Error(`${method} did not terminate within ${MAX_AGGREGATE_PAGES} page(s) for ${JSON.stringify(params)}`);
			const request = {
				...params,
				limit: Math.min(ceiling - items.length, pageItems)
			};
			if (cursor !== void 0) request["cursor"] = cursor;
			const extracted = extract(await connection.rpc.request(method, request));
			for (const item of extracted.items) {
				if (items.length >= ceiling) break;
				items.push(item);
			}
			const next = extracted.nextCursor;
			if (next === null || next === void 0) return {
				items,
				truncated: false
			};
			const advanced = String(next);
			if (extracted.items.length === 0) throw new Error(`${method} answered an empty page with nextCursor ${advanced} for ${JSON.stringify(params)}; refusing to spin on a peer that makes no progress`);
			if (advanced === cursor) throw new Error(`${method} did not advance its cursor (stuck at ${advanced}) for ${JSON.stringify(params)}`);
			cursor = advanced;
		}
	}
	/** A stopped aggregate, always carrying why it stopped and where to resume. */
	#truncated(items, reason, cursor) {
		return {
			items,
			truncated: true,
			truncationReason: reason,
			...cursor === void 0 ? {} : { nextCursor: cursor }
		};
	}
	#devicesTool() {
		return defineCherryTool({
			name: "cherry_devices",
			description: "List every paired Cherry Studio desktop with its connection state (connected/connecting/offline/disabled/identity-mismatch). An optional `device` narrows the list to one device (display name prefix or deviceId).",
			parameters: {
				type: "object",
				properties: { device: {
					type: "string",
					description: "Optional device selector: exact deviceId, or a unique display-name prefix."
				} },
				additionalProperties: false
			},
			execute: async (args) => {
				const selector = optionalString(args["device"]);
				const quarantined = this.#quarantineVerdict();
				if (quarantined !== void 0) return quarantined;
				if (selector === void 0) return { devices: this.#deps.store.list().map((record) => this.#deviceView(record)) };
				const selected = this.#selectRecords(selector);
				if (!Array.isArray(selected)) return selected;
				return { devices: selected.map((record) => this.#deviceView(record)) };
			}
		});
	}
	/**
	* The `cherry_devices` selector: candidates beat a throw (ruling ⑤), and the
	* quarantined archive outranks both.
	*
	* `cherry_unpair` shares this, so the quarantine check here is what keeps its
	* `store.remove` from ever being reached on a READ-ONLY archive — the write
	* would refuse and throw `QuarantinedArchiveError` straight out of the tool.
	*/
	#selectRecords(selector) {
		const quarantined = this.#quarantineVerdict();
		if (quarantined !== void 0) return quarantined;
		const resolution = this.#deps.store.resolve(selector);
		if ("ambiguous" in resolution) return {
			error: "ambiguous-device",
			device: selector,
			candidates: resolution.ambiguous
		};
		return [resolution];
	}
	/**
	* One device's view WITHOUT dialing.
	*
	* A disabled record is authoritative: the pooled connection is constructed
	* with its own `record.enabled` snapshot and reports `disabled` only once
	* `connect()` has run, so reading the store flag first keeps the row truthful
	* for a device whose connection was never started. Everything else falls back
	* to the connection's own CLOSED state set.
	*/
	#deviceView(record) {
		let state = record.enabled ? "offline" : "disabled";
		if (record.enabled) try {
			state = this.#deps.connect(record.deviceId).state;
		} catch (error) {
			console.warn(`[cherry-remote] cherry_devices could not read the connection for ${record.deviceId}`, error);
		}
		return {
			deviceId: record.deviceId,
			displayName: record.displayName,
			state,
			enabled: record.enabled,
			hosts: record.hosts,
			port: record.port
		};
	}
	#agentsTool() {
		return defineCherryTool({
			name: "cherry_agents",
			description: "List the Cherry Studio agents available on a device. Paginated: `limit` bounds the TOTAL across pages (default 100, max 1000) and is aggregated internally.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: MAX_AGGREGATE_LIMIT,
						description: "Maximum number of agents to return in total across pages (default 100)."
					}
				},
				required: ["device"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection } = resolved.link;
				return this.#aggregate(connection, "agent.agents.list", {}, (page) => ({
					items: arrayOf(page["items"]),
					nextCursor: page["nextCursor"]
				}), aggregateLimit(args["limit"]));
			}
		});
	}
	#workspacesTool() {
		return defineCherryTool({
			name: "cherry_workspaces",
			description: "List an agent's REGISTERED workspaces, plus whether a system workspace exists. The system workspace has no enumerable id: it is not in `items`, and its identity is only observable by creating a session in it and reading it back.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					agentId: {
						type: "string",
						description: "The agent whose workspaces to list."
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: MAX_AGGREGATE_LIMIT,
						description: "Maximum number of workspaces to return in total across pages (default 100)."
					}
				},
				required: ["device", "agentId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection } = resolved.link;
				const agentId = requiredString(args, "agentId");
				let systemWorkspace = false;
				const page = await this.#aggregate(connection, "agent.workspaces.list", { agentId }, (result) => {
					if (typeof result["systemWorkspace"] === "boolean") systemWorkspace = result["systemWorkspace"];
					return {
						items: arrayOf(result["items"]),
						nextCursor: result["nextCursor"]
					};
				}, aggregateLimit(args["limit"]));
				return {
					items: page.items,
					systemWorkspace,
					truncated: page.truncated,
					...page.truncationReason === void 0 ? {} : { truncationReason: page.truncationReason }
				};
			}
		});
	}
	#sessionsTool() {
		return defineCherryTool({
			name: "cherry_sessions",
			description: "List an agent's sessions, optionally filtered by workspace. The `agentId` and `workspaceId` filters pass straight through to the peer. Paginated: `limit` bounds the TOTAL across pages (default 100, max 1000) and is aggregated internally.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					agentId: {
						type: "string",
						description: "Only sessions of this agent."
					},
					workspaceId: {
						type: "string",
						description: "Only sessions in this registered workspace."
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: MAX_AGGREGATE_LIMIT,
						description: "Maximum number of sessions to return in total across pages (default 100)."
					}
				},
				required: ["device"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection } = resolved.link;
				const agentId = optionalString(args["agentId"]);
				const workspaceId = optionalString(args["workspaceId"]);
				return this.#aggregate(connection, "agent.sessions.list", {
					...agentId === void 0 ? {} : { agentId },
					...workspaceId === void 0 ? {} : { workspaceId }
				}, (page) => ({
					items: arrayOf(page["items"]),
					nextCursor: page["nextCursor"]
				}), aggregateLimit(args["limit"]));
			}
		});
	}
	#readTool() {
		return defineCherryTool({
			name: "cherry_read",
			description: "Read a session's message history snapshot. Two-level baseline: `agent.sessions.get` supplies the history revision, `agent.messages.list` the messages, and each message's own revision the parts. Large part text is externalized by the peer and fetched and sha256-verified through `agent.content.read`. A binary attachment is reported as `kind: \"file\"` with `name`/`mediaType`/`byteLength` and an EMPTY `content` — the bytes are deliberately not fetched into a text channel.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session to read."
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: MAX_AGGREGATE_LIMIT,
						description: "Maximum number of messages to return in total across pages (default 100)."
					}
				},
				required: ["device", "sessionId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				const limit = aggregateLimit(args["limit"]);
				await this.#ensureSubscription(record.deviceId, sessionId);
				return this.#readRound(connection, sessionId, limit, true);
			}
		});
	}
	/**
	* ONE read round: re-pull the baseline, then list and project everything.
	*
	* `retryOnExpiry` implements the §6 REVISION_EXPIRED rule — a stale revision
	* re-pulls the baseline (`sessions.get` → `messages.list`) and retries the
	* WHOLE round ONCE. A second expiry is surfaced unchanged, so a peer whose
	* revisions never settle cannot loop the caller.
	*/
	async #readRound(connection, sessionId, limit, retryOnExpiry) {
		try {
			return await this.#readOnce(connection, sessionId, limit);
		} catch (error) {
			if (retryOnExpiry && failureReason(error) === "REVISION_EXPIRED") {
				console.warn(`[cherry-remote] session ${sessionId} history revision expired; re-pulling the baseline and retrying once`);
				return this.#readRound(connection, sessionId, limit, false);
			}
			throw error;
		}
	}
	async #readOnce(connection, sessionId, limit) {
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const historyRevision = session["historyRevision"];
		if (typeof historyRevision !== "string") throw new Error(`agent.sessions.get returned no historyRevision for session ${sessionId}`);
		const page = await this.#aggregate(connection, "agent.messages.list", {
			sessionId,
			historyRevision
		}, (result) => ({
			items: arrayOf(result["items"]),
			nextCursor: result["nextCursor"]
		}), limit);
		const messages = [];
		for (const raw of page.items) messages.push(await this.#projectMessage(connection, sessionId, raw));
		return {
			session,
			messages,
			truncated: page.truncated,
			...page.truncationReason === void 0 ? {} : { truncationReason: page.truncationReason }
		};
	}
	/** One message: list ALL its parts under the message's OWN revision, then aggregate. */
	async #projectMessage(connection, sessionId, raw) {
		const messageId = String(raw["messageId"] ?? "");
		const revision = String(raw["revision"] ?? "");
		const page = await this.#aggregate(connection, "agent.parts.list", {
			sessionId,
			messageId,
			messageRevision: revision
		}, (result) => ({
			items: arrayOf(result["items"]),
			nextCursor: result["nextCursor"]
		}), Number.POSITIVE_INFINITY, this.#partsSafetyBound, PARTS_LIST_PAGE_CLAMP);
		const parts = [];
		for (const part of page.items) parts.push(await this.#projectPart(connection, sessionId, part));
		return {
			messageId,
			revision,
			role: String(raw["role"] ?? ""),
			status: String(raw["status"] ?? ""),
			parts,
			...page.truncated ? {
				partsTruncated: page.truncationReason ?? "safety-bound",
				...page.nextCursor === void 0 ? {} : { partsResumeCursor: page.nextCursor }
			} : {}
		};
	}
	/**
	* One part, with `{ref}` content resolved through `agent.content.read`.
	*
	* The slices are reassembled in ≤24 KiB steps and the WHOLE content's sha256
	* (what the ref advertises, and what the peer returns on every slice) is
	* verified against the reassembled bytes before any text is handed back.
	*/
	async #projectPart(connection, sessionId, raw) {
		const partId = String(raw["partId"] ?? "");
		const revision = String(raw["revision"] ?? "");
		const kind = String(raw["kind"] ?? "");
		const content = isRecord(raw["content"]) ? raw["content"] : {};
		if (kind === "file") return {
			partId,
			kind,
			revision,
			content: "",
			...this.#attachmentFace(kind, raw, content),
			...typeof raw["state"] === "string" ? { state: raw["state"] } : {},
			...typeof raw["toolName"] === "string" ? { toolName: raw["toolName"] } : {},
			...typeof raw["toolCallId"] === "string" ? { toolCallId: raw["toolCallId"] } : {}
		};
		let text;
		if (typeof content["text"] === "string") text = content["text"];
		else if (isRecord(content["ref"])) try {
			text = await this.#readExternalized(connection, sessionId, content["ref"]);
		} catch (error) {
			if (!this.#degradableReadFailure(error)) throw error;
			return {
				partId,
				kind,
				revision,
				content: "",
				unavailable: unavailableReason(error),
				...typeof raw["state"] === "string" ? { state: raw["state"] } : {},
				...typeof raw["toolName"] === "string" ? { toolName: raw["toolName"] } : {},
				...typeof raw["toolCallId"] === "string" ? { toolCallId: raw["toolCallId"] } : {}
			};
		}
		else text = "";
		return {
			partId,
			kind,
			revision,
			content: text,
			...this.#attachmentFace(kind, raw, content),
			...typeof raw["state"] === "string" ? { state: raw["state"] } : {},
			...typeof raw["toolName"] === "string" ? { toolName: raw["toolName"] } : {},
			...typeof raw["toolCallId"] === "string" ? { toolCallId: raw["toolCallId"] } : {}
		};
	}
	/**
	* The descriptive metadata of an attachment part — and deliberately NOT a
	* way to reach its bytes.
	*
	* Two peer generations are covered, because both are inside the verified
	* range and they disagree about where the metadata lives:
	*
	*  - **Cherry ≥ 2.1.5** — `{kind: 'file', name, ref}`, ref at the TOP level.
	*  - **Cherry 2.1.4** — `{kind: 'data', name, content: {mediaType, filename}}`.
	*
	* Only string fields are lifted: a null `filename` (the peer's explicit "no
	* name") stays absent rather than becoming the string "null". Anything a
	* caller needs beyond this — the bytes — stays behind `agent.content.read`,
	* which this plugin does not call for a file part.
	*/
	#attachmentFace(kind, raw, content) {
		if (kind !== "file" && kind !== "data") return {};
		const ref = isRecord(raw["ref"]) ? raw["ref"] : isRecord(content["ref"]) ? content["ref"] : {};
		const name = kind === "file" ? optionalString(raw["name"]) : optionalString(content["filename"]);
		const mediaType = optionalString(ref["mediaType"]) ?? optionalString(content["mediaType"]);
		const byteLength = optionalString(ref["byteLength"]);
		return {
			...name === void 0 ? {} : { name },
			...mediaType === void 0 ? {} : { mediaType },
			...byteLength === void 0 ? {} : { byteLength }
		};
	}
	/**
	* Whether one `{ref}` read failure may DEGRADE (the part is marked
	* unavailable) rather than fail the whole `cherry_read`.
	*
	* The line is drawn at WHO COULD BE TRUSTED, not at how inconvenient the
	* failure is:
	*
	*  - **Degradable** — the peer refused or could not complete the read: a
	*    `NOT_FOUND` pin, a transient RPC failure, a non-advancing cursor. Nothing
	*    was returned, so there is nothing to misreport; the honest report is
	*    "this part's text could not be read", and the rest of the snapshot is
	*    still exactly what the peer said it was.
	*  - **NOT degradable — an INTEGRITY failure.** The peer DID answer and the
	*    reassembled bytes do NOT match the digest the ref advertises. Those bytes
	*    are provably not the content the ref describes, so degrading would hand
	*    back a snapshot that looks complete while containing content the peer
	*    never certified. That is worse than an error: the caller cannot tell it
	*    apart from a good read. It keeps failing loudly.
	*
	* The discriminator is the DIGEST CHECK specifically, which is why
	* {@link CherryToolEngine.#readExternalized} marks it: matching on message
	* text would break the moment the wording changed.
	*/
	#degradableReadFailure(error) {
		return !(error instanceof ContentIntegrityError);
	}
	/** Paginate `agent.content.read` over one `{ref}` and verify its sha256. */
	async #readExternalized(connection, sessionId, ref) {
		const contentId = String(ref["contentId"] ?? "");
		const revision = String(ref["revision"] ?? "");
		const declaredSha = typeof ref["sha256"] === "string" ? ref["sha256"] : void 0;
		const declaredBytes = Number(ref["byteLength"]);
		const maxSlices = Number.isSafeInteger(declaredBytes) ? Math.max(1, Math.ceil(declaredBytes / CONTENT_READ_MAX_BYTES)) : DEFAULT_CONTENT_SLICE_BOUND;
		const chunks = [];
		let offset = "0";
		let sha;
		let complete = false;
		for (let sliceIndex = 0; sliceIndex < maxSlices; sliceIndex += 1) {
			const slice = await connection.rpc.request("agent.content.read", {
				sessionId,
				contentId,
				revision,
				offset,
				maxBytes: CONTENT_READ_MAX_BYTES
			});
			const data = typeof slice["dataBase64"] === "string" ? slice["dataBase64"] : "";
			chunks.push(new Uint8Array(Buffer.from(data, "base64")));
			if (typeof slice["sha256"] === "string") sha = slice["sha256"];
			if (slice["eof"] === true) {
				complete = true;
				break;
			}
			const next = slice["nextOffset"];
			if (typeof next !== "string" || next === offset) throw new ContentIntegrityError(`agent.content.read for ${contentId} did not advance (offset ${offset})`);
			offset = next;
		}
		if (!complete) throw new ContentIntegrityError(`agent.content.read for ${contentId} did not reach eof within ${maxSlices} slice(s); refusing to aggregate a partial content`);
		const bytes = Buffer.concat(chunks);
		const expected = sha ?? declaredSha;
		if (expected === void 0) throw new ContentIntegrityError(`agent.content.read for ${contentId} returned no sha256 to verify`);
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== expected) throw new ContentIntegrityError(`agent.content.read for ${contentId} failed its sha256 check (expected ${expected}, got ${actual})`);
		return bytes.toString("utf8");
	}
	#eventsTool() {
		return defineCherryTool({
			name: "cherry_events",
			description: "Read the session's buffered events newer than `cursor`, delivering them and then acknowledging the advanced cursor to the peer. While the window has dropped no events, every cursor this plugin handed out is servable, including the baseline `cherry_send`/`cherry_wait` report on an empty window. Once the window DISCARDS events, the boundary it reports is not: that boundary and everything below it answer a structured `cursor-out-of-window` verdict, and only positions strictly past it are served — rebuild the baseline with `cherry_read` and resume from that instead.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session whose events to read."
					},
					cursor: {
						type: "object",
						properties: {
							sessionId: { type: "string" },
							streamEpoch: { type: "string" },
							seq: { type: "string" }
						},
						required: [
							"sessionId",
							"streamEpoch",
							"seq"
						],
						additionalProperties: false,
						description: "Resume point: the last cursor the caller consumed."
					}
				},
				required: ["device", "sessionId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				const subscriptions = this.#deps.subs(record.deviceId);
				await this.#ensureSubscription(record.deviceId, sessionId);
				const cursor = readCursor(args["cursor"]);
				const result = subscriptions.read(sessionId, cursor);
				if ("error" in result) return {
					error: "cursor-out-of-window",
					message: `the requested cursor is before the cache window start for session ${sessionId}, or at it after the cache discarded events; the window can no longer prove continuity from that position. Use cherry_read to rebuild the baseline, or cherry_events with no cursor to read the whole retained window`,
					windowStart: this.#windowStart(subscriptions, sessionId)
				};
				try {
					await subscriptions.ack(sessionId, result.nextCursor);
				} catch (error) {
					console.warn(`[cherry-remote] acknowledging session ${sessionId} at ${result.nextCursor.seq} failed`, error);
				}
				return {
					events: result.events,
					nextCursor: result.nextCursor
				};
			}
		});
	}
	#createTool() {
		return defineCherryTool({
			name: "cherry_create",
			description: "Create a session in an agent workspace. The workspace selection is MANDATORY and explicit: pass `workspaceId` for a registered workspace, or `workspace: \"system\"` for the system workspace (which has no enumerable id). There is no implicit default. The receipt carries only the sessionId, so the workspace identity is read back through agent.sessions.get.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					agentId: {
						type: "string",
						description: "The agent that owns the new session."
					},
					workspaceId: {
						type: "string",
						description: "The registered workspace to create the session in. Mutually exclusive with `workspace`."
					},
					workspace: {
						type: "string",
						enum: ["system"],
						description: "The literal \"system\" selects the system workspace. Mutually exclusive with `workspaceId`."
					},
					title: {
						type: "string",
						description: "Optional session title."
					},
					commandId: {
						type: "string",
						description: "Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely."
					}
				},
				required: ["device", "agentId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const agentId = requiredString(args, "agentId");
				const workspaceId = optionalString(args["workspaceId"]);
				const system = args["workspace"] === "system";
				const title = optionalString(args["title"]);
				if (workspaceId !== void 0 && system) return {
					error: "invalid-workspace-selection",
					message: "specify either `workspaceId` or `workspace: \"system\"`, not both"
				};
				if (workspaceId === void 0 && !system) return {
					error: "workspace-required",
					message: "a workspace selection is required: pass `workspaceId` for a registered workspace, or `workspace: \"system\"` for the system workspace"
				};
				if (args["workspace"] !== void 0 && !system) return {
					error: "invalid-workspace-selection",
					message: "`workspace` accepts exactly the literal \"system\""
				};
				const receipt = await this.#command(connection, "agent.sessions.create", {
					commandId: this.#commandId(args),
					agentId,
					...system ? { workspace: { kind: "system" } } : { workspaceId },
					...title === void 0 ? {} : { title }
				});
				const sessionId = typeof receipt["sessionId"] === "string" ? receipt["sessionId"] : void 0;
				if (sessionId === void 0) return receipt;
				const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
				const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
				const created = {
					sessionId,
					device: record.deviceId,
					...typeof session["workspaceId"] === "string" ? { workspaceId: session["workspaceId"] } : {},
					...typeof session["workspaceKind"] === "string" ? { workspaceKind: session["workspaceKind"] } : {},
					session
				};
				return {
					...receipt,
					...created
				};
			}
		});
	}
	#sendTool() {
		return defineCherryTool({
			name: "cherry_send",
			description: "Send a message to a session and, by default, wait for the run to reach a terminal state (completed/failed/cancelled/interrupted), then aggregate the assistant text. A pending interaction ends the wait EARLY as a soft terminal (`awaiting-interaction`): answer it with cherry_interactions + cherry_respond, then resume with cherry_wait. `wait: false` returns the command receipt immediately. A timeout is NOT a failure — it returns the partial content and the cursor to resume from.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session to send into."
					},
					text: {
						type: "string",
						maxLength: TEXT_MAX_LENGTH,
						description: `The message text, which must not be blank. At most ${TEXT_MAX_LENGTH} characters (the protocol ceiling).`
					},
					wait: {
						type: "boolean",
						description: "Wait for a terminal state (default true). False returns the command receipt at once."
					},
					timeoutMs: {
						type: "integer",
						minimum: MIN_WAIT_TIMEOUT_MS,
						description: `How long to wait, in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}). A default, not a cap.`
					},
					commandId: {
						type: "string",
						description: "Optional idempotency id. Omit to have one generated; REUSE the same id to retry a command whose outcome is unknown."
					}
				},
				required: [
					"device",
					"sessionId",
					"text"
				],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				const text = requiredString(args, "text");
				if (text.length > TEXT_MAX_LENGTH) return {
					error: "text-too-long",
					limit: TEXT_MAX_LENGTH,
					length: text.length,
					message: `the message is ${text.length} characters; the protocol caps a single send at ${TEXT_MAX_LENGTH}. Split it into several cherry_send calls.`
				};
				if (text.trim().length === 0) return {
					error: "text-empty",
					message: "the message text is empty (or whitespace only); the peer requires a non-blank body."
				};
				await this.#ensureSubscription(record.deviceId, sessionId);
				const subscriptions = this.#deps.subs(record.deviceId);
				const { receipt, baselineSeq } = await this.#admitSend(connection, subscriptions, record.deviceId, sessionId, {
					args,
					text
				});
				if (args["wait"] === false) return receipt;
				if (receipt["status"] === "rejected" || receipt["status"] === "interrupted") return receipt;
				const timeoutMs = waitTimeout(args["timeoutMs"]);
				return this.#awaitRun(connection, subscriptions, sessionId, {
					timeoutMs,
					startedAt: performance.now(),
					baselineSeq,
					executionId: typeof receipt["executionId"] === "string" ? receipt["executionId"] : void 0,
					commandId: typeof receipt["commandId"] === "string" ? receipt["commandId"] : void 0
				});
			}
		});
	}
	/**
	* Issues `agent.messages.send` and returns the receipt the caller should act
	* on — self-healing ONCE a stale admission baseline.
	*
	* `expectedIdleRevision` comes from the CACHE's session snapshot. A cold cache
	* is baselined first (`sessions.get`), so the value is always one the peer
	* itself reported; a warm one is trusted without revalidation. That trust is
	* what issue #1 breaks: the cache's freshest source is the event stream, and
	* the stream's buffer is dropped WHOLESALE when its epoch rotates, a
	* re-subscribe rebuilds it, or the LRU evicts it. With the buffer empty the
	* cached value can be arbitrarily old, the peer refuses admission with
	* CONFLICT "Session is not idle at the expected revision", and the same stale
	* entry would be sent again on every later call: a PERMANENT conflict.
	*
	* So a refusal on exactly that ground earns ONE re-baseline and ONE retry:
	*
	*  - "Session is busy" is a DIFFERENT refusal and is never retried. It says
	*    the peer has a run in flight, so the revision is not even the question
	*    and a second attempt could only fail; the receipt is final.
	*  - The retry asks the peer (`agent.sessions.get`) rather than guessing a
	*    revision, and only when that snapshot shows an IDLE session: it must
	*    report NO `activeExecutionId` AND carry an `idleRevision`/
	*    `historyRevision` to quote. A busy session means the first receipt
	*    stands. (A busy summary DOES carry a mid-run `historyRevision`, so the
	*    execution check — not the revision's absence — is what decides this.)
	*  - The retry QUOTES the revision that read returned, rather than letting
	*    `#idleRevision` re-derive one: that helper prefers the event stream, and
	*    a stale buffered `session.updated` would hand back the revision the peer
	*    has just refused.
	*  - The retry uses a FRESH `randomUUID()`, never the caller's id. The peer
	*    settled the refused command in its ledger as `rejected`, and the retry's
	*    body DIFFERS (a new `expectedIdleRevision`): replaying that id would
	*    return the recorded refusal, and a differing body under a settled id is
	*    the peer's IDEMPOTENCY_CONFLICT. A new id is a new command.
	*  - Exactly one retry. A second refusal is returned as-is — the peer has
	*    then answered this caller twice, and a third attempt would just loop.
	*
	* The returned `baselineSeq` belongs to the attempt whose receipt is
	* returned: the caller's waiter must fold events that arrived after the
	* command which actually started the run.
	*/
	async #admitSend(connection, subscriptions, deviceId, sessionId, request) {
		const { args, text } = request;
		const attempt = async (commandId, revisionOverride) => {
			const expectedIdleRevision = revisionOverride ?? await this.#idleRevision(connection, subscriptions, deviceId, sessionId);
			const baselineSeq = this.#newestSeq(subscriptions, sessionId);
			return {
				receipt: await this.#command(connection, "agent.messages.send", {
					commandId,
					sessionId,
					text,
					expectedIdleRevision
				}),
				baselineSeq
			};
		};
		const first = await attempt(this.#commandId(args));
		if (!isStaleRevisionRefusal(first.receipt)) return first;
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const idle = optionalString(session["idleRevision"]) ?? optionalString(session["historyRevision"]);
		if (idle === void 0 || optionalString(session["activeExecutionId"]) !== void 0) return first;
		this.#revisionCache.set(this.#cacheKey(deviceId, sessionId), idle);
		return attempt(randomUUID(), idle);
	}
	#waitTool() {
		return defineCherryTool({
			name: "cherry_wait",
			description: "Wait for a session's in-flight execution to reach a terminal state, without sending anything. Returns the same shape as `cherry_send(wait: true)`. A session with no in-flight execution answers IMMEDIATELY with its current snapshot (status `idle`) — never an error, never a park. Use it to resume after answering an interaction.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session to wait on."
					},
					timeoutMs: {
						type: "integer",
						minimum: MIN_WAIT_TIMEOUT_MS,
						description: `How long to wait, in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}). A default, not a cap.`
					}
				},
				required: ["device", "sessionId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				await this.#ensureSubscription(record.deviceId, sessionId);
				const subscriptions = this.#deps.subs(record.deviceId);
				const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
				const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
				const activeExecutionId = optionalString(session["activeExecutionId"]);
				if (activeExecutionId === void 0) {
					const idle = optionalString(session["idleRevision"]) ?? optionalString(session["historyRevision"]);
					if (idle !== void 0) this.#revisionCache.set(this.#cacheKey(record.deviceId, sessionId), idle);
					const assembled = await this.#assembledTerminalMessages(connection, sessionId, session, {
						status: "idle",
						sessionId,
						cursor: this.#cursorOf(subscriptions, sessionId)
					});
					if (assembled.failed !== void 0) return {
						...assembled.failed,
						session,
						executionId: null
					};
					return {
						status: "idle",
						sessionId,
						session,
						executionId: null,
						messages: assembled.messages,
						cursor: this.#cursorOf(subscriptions, sessionId),
						...assembled.walk
					};
				}
				return this.#awaitRun(connection, subscriptions, sessionId, {
					timeoutMs: waitTimeout(args["timeoutMs"]),
					startedAt: performance.now(),
					executionId: activeExecutionId
				});
			}
		});
	}
	#interactionsTool() {
		return defineCherryTool({
			name: "cherry_interactions",
			description: "List the session's PENDING interactions (questions and approval decisions) that need an answer. The peer serves the full four-state set (pending/approved/denied/expired) — the pending filter is applied here. Each entry carries its `kind` (question|decision) and a summary; answer questions with cherry_respond's `response` form and decisions with `decision`.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session whose interactions to list."
					},
					includeAnswered: {
						type: "boolean",
						description: "Include already-answered interactions too (default false). The peer always returns them; this only controls the local filter."
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: MAX_AGGREGATE_LIMIT,
						description: "Maximum number of interactions to return in total across pages (default 100)."
					}
				},
				required: ["device", "sessionId"],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				await this.#ensureSubscription(record.deviceId, sessionId);
				const page = await this.#aggregate(connection, "agent.interactions.list", { sessionId }, (result) => ({
					items: arrayOf(result["items"]),
					nextCursor: result["nextCursor"]
				}), aggregateLimit(args["limit"]), MAX_AGGREGATE_LIMIT, INTERACTIONS_LIST_PAGE_CLAMP);
				const includeAnswered = args["includeAnswered"] === true;
				const items = page.items.filter((item) => includeAnswered || item["status"] === "pending").map((item) => this.#interactionView(item));
				for (const item of page.items) this.#rememberInteraction(record.deviceId, sessionId, item);
				return {
					items,
					truncated: page.truncated,
					...page.truncationReason === void 0 ? {} : { truncationReason: page.truncationReason }
				};
			}
		});
	}
	/** The tool-facing projection of one interaction. */
	#interactionView(raw) {
		const kind = typeof raw["kind"] === "string" ? raw["kind"] : "decision";
		return {
			interactionId: String(raw["interactionId"] ?? ""),
			revision: String(raw["revision"] ?? ""),
			executionId: String(raw["executionId"] ?? ""),
			toolCallId: String(raw["toolCallId"] ?? ""),
			status: String(raw["status"] ?? ""),
			kind,
			summary: String(raw["summary"] ?? ""),
			...typeof raw["inputDigest"] === "string" ? { inputDigest: raw["inputDigest"] } : {},
			...kind === "question" ? { questions: questionKeysOf(raw["input"]) } : {}
		};
	}
	#respondTool() {
		return defineCherryTool({
			name: "cherry_respond",
			description: "Answer a pending interaction. A `question` MUST be answered with `response: {kind: \"answer\", answers: {...}}`, keyed by the FULL question text and covering EVERY question (the peer refuses a partial set with CONFLICT). Approving a question is refused; use `decision: \"deny\"` to abandon one. A `decision` card takes `decision: \"approve\" | \"deny\"`. The staleness triple (expectedRevision / expectedExecutionId / inputDigest) is taken from the subscription cache, not from the caller.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session holding the interaction."
					},
					interactionId: {
						type: "string",
						description: "The interaction to answer."
					},
					decision: {
						type: "string",
						enum: ["approve", "deny"],
						description: "For a `decision` card. `deny` is also the sanctioned way to abandon a question."
					},
					response: {
						type: "object",
						properties: {
							kind: {
								type: "string",
								enum: ["answer"]
							},
							answers: {
								type: "object",
								additionalProperties: { type: "string" },
								description: "Every question text mapped to its answer. Blank answers are refused."
							}
						},
						required: ["kind", "answers"],
						additionalProperties: false,
						description: "The structured answer form, required for a `question` card."
					},
					commandId: {
						type: "string",
						description: "Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely."
					}
				},
				required: [
					"device",
					"sessionId",
					"interactionId"
				],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				const interactionId = requiredString(args, "interactionId");
				const decision = optionalString(args["decision"]);
				const response = isRecord(args["response"]) ? args["response"] : void 0;
				if (decision === void 0 && response === void 0) return {
					error: "response-required",
					message: "provide either `decision` (approve|deny) or `response` ({kind:\"answer\", answers})"
				};
				if (decision !== void 0 && response !== void 0) return {
					error: "ambiguous-response",
					message: "provide either `decision` or `response`, not both"
				};
				if (decision !== void 0 && decision !== "approve" && decision !== "deny") return {
					error: "invalid-decision",
					message: "`decision` accepts exactly \"approve\" or \"deny\""
				};
				if (response !== void 0) {
					const answers = response["answers"];
					if (response["kind"] !== "answer" || !isRecord(answers)) return {
						error: "invalid-response",
						message: "`response` must be {kind:\"answer\", answers:{<question text>: <answer>}}"
					};
				}
				await this.#ensureSubscription(record.deviceId, sessionId);
				const subscriptions = this.#deps.subs(record.deviceId);
				const snapshot = await this.#interactionSnapshot(connection, subscriptions, record.deviceId, sessionId, interactionId);
				if (snapshot === void 0) return {
					error: "unknown-interaction",
					message: `no interaction ${interactionId} is known for session ${sessionId}`
				};
				return this.#command(connection, "agent.interactions.respond", {
					commandId: this.#commandId(args),
					sessionId,
					interactionId,
					expectedRevision: snapshot.revision,
					expectedExecutionId: snapshot.executionId,
					inputDigest: snapshot.inputDigest,
					...response === void 0 ? { decision } : { response }
				});
			}
		});
	}
	#cancelTool() {
		return defineCherryTool({
			name: "cherry_cancel",
			description: "Cancel a session's in-flight execution. `expectedExecutionId` is REQUIRED by the protocol and is checked against the subscription cache's current active execution: pass the id a previous result reported, and the call succeeds only while it is still the active run. A divergence is refused in band with the id the cache actually holds, so a stale caller is told what to re-read rather than cancelling the wrong execution.",
			parameters: {
				type: "object",
				properties: {
					device: {
						type: "string",
						description: "Device selector: exact deviceId, or a unique display-name prefix."
					},
					sessionId: {
						type: "string",
						description: "The session whose execution to cancel."
					},
					expectedExecutionId: {
						type: "string",
						description: "The execution to cancel. Required by the protocol; must match the cached active execution, so the caller can only cancel a run it has actually observed."
					},
					commandId: {
						type: "string",
						description: "Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely."
					}
				},
				required: [
					"device",
					"sessionId",
					"expectedExecutionId"
				],
				additionalProperties: false
			},
			execute: async (args) => {
				const resolved = this.#linkOr(requiredString(args, "device"));
				if (resolved.link === void 0) return resolved.verdict;
				const { connection, record } = resolved.link;
				const sessionId = requiredString(args, "sessionId");
				await this.#ensureSubscription(record.deviceId, sessionId);
				const subscriptions = this.#deps.subs(record.deviceId);
				const expectedExecutionId = await this.#activeExecutionId(connection, subscriptions, record.deviceId, sessionId);
				if (expectedExecutionId === void 0) return {
					error: "no-active-execution",
					message: `session ${sessionId} has no in-flight execution to cancel`
				};
				const supplied = optionalString(args["expectedExecutionId"]);
				if (supplied !== void 0 && supplied !== expectedExecutionId) return {
					error: "execution-mismatch",
					expectedExecutionId,
					supplied,
					message: `the cached active execution is ${expectedExecutionId}, not ${supplied}; re-read the session before cancelling`
				};
				return this.#command(connection, "agent.executions.cancel", {
					commandId: this.#commandId(args),
					sessionId,
					expectedExecutionId
				});
			}
		});
	}
	#pairTool() {
		return defineCherryTool({
			name: "cherry_pair",
			description: "Pair this harness with a Cherry Studio desktop from its pairing information. The desktop shows only a QR CODE: scan it (WeChat, a browser) and paste the pairing information that page displays. The 6-digit `verificationCode` the desktop displays is returned so the user can confirm it matches. Every outcome is a RESULT, never an error: `status` is \"approved\" (with the new device id), or the terminal \"rejected\"/\"expired\" verdict, or this plugin's own \"invalid-payload\"/\"unreachable\", or \"archive-quarantined\" when the device archive is unreadable and must be moved aside by hand. Pairing can take up to a minute — it waits for the user to approve on the desktop.",
			parameters: {
				type: "object",
				properties: {
					payload: {
						type: "string",
						description: "The pairing information shown by the page the desktop QR code points at (a JSON string). Scan that code with WeChat or a browser and copy the text from there."
					},
					name: {
						type: "string",
						description: "Optional display name for this device as the desktop will show it (default: this host's name)."
					}
				},
				required: ["payload"],
				additionalProperties: false
			},
			execute: async (args) => {
				const payload = requiredString(args, "payload");
				const name = optionalString(args["name"]);
				let verificationCode;
				return {
					...await this.#runPair({
						payload,
						...name === void 0 ? {} : { name },
						onVerificationCode: (code) => {
							verificationCode = code;
						}
					}),
					...verificationCode === void 0 ? {} : { verificationCode }
				};
			}
		});
	}
	/**
	* Runs one pairing and maps its outcome onto {@link CherryPairResult}.
	*
	* The mapping is TOTAL over the outcome currency a pairing can legitimately
	* reach: `PairingError.kind` IS the result's `status`, and the quarantined
	* archive — the run's LAST step, the persist — gets its own structured status
	* rather than an exception. "Every pairing outcome is a RESULT" is the tool's
	* whole contract: a damaged `devices.json` is a condition the caller must be
	* told about in-band, with the recovery step, not a raw file error thrown out
	* of a tool call. Anything else that is NOT a `PairingError` is a real fault
	* (a bug, or the identity not being loaded yet) and is rethrown — the tool has
	* no honest in-band shape for "this should not have happened".
	*/
	async #runPair(request) {
		try {
			const record = await this.#deps.pair(request);
			return {
				status: "approved",
				device: record.deviceId,
				displayName: record.displayName
			};
		} catch (error) {
			if (error instanceof QuarantinedArchiveError) return {
				status: "archive-quarantined",
				message: `${QUARANTINE_RECOVERY} (archive: ${error.file}; preserved as ${error.corruptPath ?? `${error.file}.corrupt`})`
			};
			if (!(error instanceof PairingError)) throw error;
			return {
				status: error.kind,
				message: error.message
			};
		}
	}
	#unpairTool() {
		return defineCherryTool({
			name: "cherry_unpair",
			description: "Forget a paired desktop: tear its connection down and delete it from the device archive, so this harness no longer holds its access token. The `device` selector is REQUIRED (an exact deviceId, or a unique display-name prefix); unpairing is permanent and the device must be paired again from a fresh QR code.",
			parameters: {
				type: "object",
				properties: { device: {
					type: "string",
					description: "Device selector: exact deviceId, or a unique display-name prefix."
				} },
				required: ["device"],
				additionalProperties: false
			},
			execute: async (args) => {
				const selector = requiredString(args, "device");
				const selected = this.#selectRecords(selector);
				if (!Array.isArray(selected)) return selected;
				const record = selected[0];
				this.#forgetDevice(record.deviceId);
				await this.#deps.evict(record.deviceId);
				try {
					this.#deps.store.remove(record.deviceId);
				} catch (error) {
					if (error instanceof QuarantinedArchiveError) return {
						error: "archive-quarantined",
						guidance: QUARANTINE_RECOVERY,
						archive: error.file,
						...error.corruptPath === void 0 ? {} : { preservedAs: error.corruptPath }
					};
					throw error;
				}
				return {
					device: record.deviceId,
					displayName: record.displayName,
					removed: true
				};
			}
		});
	}
	/**
	* Issues one command and returns its RECEIPT verbatim.
	*
	* A receipt (`accepted`/`applied`/`rejected`/`interrupted`) is the peer's
	* own record of a command and is handed back UNCHANGED — including its
	* `error`, which is a receipt field, not a thrown RPC error. Transport and
	* subscription failures still reject this call: the two surfaces stay
	* distinct all the way to the caller (spec §6).
	*
	* ONE exception, and it is a HINT rather than a translation: the peer's
	* `IDEMPOTENCY_CONFLICT` — the same `commandId` re-used with a DIFFERENT body
	* — carries the §6 recovery advice on the rethrown error (see
	* {@link withIdempotencyHint}). The reason, the `data` and the failure
	* currency are untouched; only the prose a caller reads grows the actionable
	* half.
	*/
	async #command(connection, method, params) {
		try {
			return await connection.rpc.request(method, params);
		} catch (error) {
			throw withIdempotencyHint(error);
		}
	}
	/**
	* The commandId for this call. A caller-supplied id is honoured verbatim —
	* that is what makes a RETRY reuse the same id (and what makes a differing
	* body under the same id surface as the peer's IDEMPOTENCY_CONFLICT rather
	* than being silently re-run). Otherwise a fresh uuid is generated.
	*/
	#commandId(args) {
		return optionalString(args["commandId"]) ?? randomUUID();
	}
	/**
	* The cache key for one session's revision/execution snapshot.
	*
	* DEVICE-SCOPED, and that is not defensive padding: this engine is
	* ENGINE-GLOBAL (one instance serves every device the pool holds) while a
	* `sessionId` is the PEER's identifier, not this plugin's. Two desktops can
	* hand out the same session id, and a bare-sessionId key then injects the
	* first device's `idleRevision`/`activeExecutionId` into the second device's
	* commands — revisions and executions its peer has never issued. The `\u0000`
	* separator makes the composite unambiguous (neither id may contain NUL).
	*/
	#cacheKey(deviceId, sessionId) {
		return `${deviceId}\u0000${sessionId}`;
	}
	/** The subscription cache key for one interaction's staleness snapshot. */
	#interactionKey(deviceId, sessionId, interactionId) {
		return `${deviceId}\u0000${sessionId}\u0000${interactionId}`;
	}
	/**
	* Every cache key that belongs to one device, for eviction.
	*
	* A prefix match is safe because the device id is the FIRST component and the
	* separator cannot appear inside an id: the only strings that start with
	* `${deviceId}\u0000` are that device's own entries. Called when the device
	* leaves the archive (`cherry_unpair`), so a re-paired device cannot inherit
	* the previous pairing's snapshots and a long-lived process does not
	* accumulate entries for devices that no longer exist.
	*/
	#forgetDevice(deviceId) {
		const prefix = `${deviceId}\u0000`;
		for (const key of [...this.#revisionCache.keys()]) if (key.startsWith(prefix)) this.#revisionCache.delete(key);
		for (const key of [...this.#executionCache.keys()]) if (key.startsWith(prefix)) this.#executionCache.delete(key);
		for (const key of [...this.#interactionCache.keys()]) if (key.startsWith(prefix)) this.#interactionCache.delete(key);
	}
	/**
	* The session's current idle revision, from the SUBSCRIPTION CACHE.
	*
	* Two sources, in this order:
	*  1. the REAL-TIME event stream — a `session.updated` carries the peer's own
	*     `idleRevision`, which is the freshest value the plugin can hold;
	*  2. a baseline `agent.sessions.get`, used when the cache has nothing.
	*
	* The sent `expectedIdleRevision` must be a revision the peer recognises as
	* current, so the baseline is mandatory rather than optional: guessing would
	* earn a CONFLICT from a session that had merely moved on.
	*/
	async #idleRevision(connection, subscriptions, deviceId, sessionId) {
		const streamed = this.#streamedIdleRevision(subscriptions, sessionId);
		if (streamed !== void 0) {
			this.#revisionCache.set(this.#cacheKey(deviceId, sessionId), streamed);
			return streamed;
		}
		const cached = this.#revisionCache.get(this.#cacheKey(deviceId, sessionId));
		if (cached !== void 0) return cached;
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const idle = optionalString(session["idleRevision"]) ?? optionalString(session["historyRevision"]);
		if (idle === void 0) throw new Error(`agent.sessions.get returned no idle revision for session ${sessionId}`);
		this.#revisionCache.set(this.#cacheKey(deviceId, sessionId), idle);
		return idle;
	}
	/** The newest idle/history revision the session's live events have carried. */
	#streamedIdleRevision(subscriptions, sessionId) {
		let revision;
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			if (String(entry["kind"] ?? "") !== "session.updated") continue;
			const payload = isRecord(entry["payload"]) ? entry["payload"] : {};
			revision = optionalString(payload["idleRevision"]) ?? optionalString(payload["historyRevision"]) ?? revision;
		}
		return revision;
	}
	/**
	* The session's ACTIVE execution id, from the most authoritative source
	* available — in this order:
	*
	*  1. the live `execution.updated` stream (a non-terminal status means the run
	*     is still in flight; a terminal one means nothing is);
	*  2. the PEER's current `agent.sessions.get` snapshot, which is the ground
	*     truth about what is running right now;
	*  3. the local cache, and only as a value the peer CONFIRMS — a cached id the
	*     peer no longer reports is dropped rather than returned.
	*
	* The cache deliberately does NOT outrank the peer (I2): a stale entry would
	* otherwise become the `execution-mismatch` authority, refusing a caller that
	* holds the CORRECT live id and telling it the wrong one.
	*
	* Shared by `cherry_cancel` and the responder's `expectedExecutionId` — ONE
	* source, so the two can never disagree about what is running.
	*/
	async #activeExecutionId(connection, subscriptions, deviceId, sessionId) {
		const streamed = this.#streamedActiveExecution(subscriptions, sessionId);
		if (streamed !== void 0) {
			this.#executionCache.set(this.#cacheKey(deviceId, sessionId), streamed);
			return streamed;
		}
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const idle = optionalString(session["idleRevision"]) ?? optionalString(session["historyRevision"]);
		if (idle !== void 0) this.#revisionCache.set(this.#cacheKey(deviceId, sessionId), idle);
		const active = optionalString(session["activeExecutionId"]);
		if (active !== void 0) {
			this.#executionCache.set(this.#cacheKey(deviceId, sessionId), active);
			return active;
		}
		this.#executionCache.delete(this.#cacheKey(deviceId, sessionId));
	}
	/**
	* The live stream's verdict on the session's active execution: the newest
	* `execution.updated`'s executionId while it is non-terminal, or undefined
	* once it has settled (the run is over, so nothing is active).
	*/
	#streamedActiveExecution(subscriptions, sessionId) {
		let active;
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			if (String(entry["kind"] ?? "") !== "execution.updated") continue;
			const payload = isRecord(entry["payload"]) ? entry["payload"] : {};
			const executionId = optionalString(payload["executionId"]);
			const status = optionalString(payload["status"]);
			if (executionId === void 0 || status === void 0) continue;
			active = TERMINAL_EXECUTION_STATUSES.includes(status) ? void 0 : executionId;
		}
		return active;
	}
	/**
	* The cached interaction snapshot — the SOURCE of respond's staleness triple.
	*
	* Two sources, in this order:
	*  1. the REAL-TIME `interaction.updated` stream, folded into the cache before
	*     every lookup (spec §3.6: the soft terminal rides exactly these events);
	*  2. ONE `agent.interactions.list` query, when the stream has never carried
	*     this interaction. That path is not optional: an approval card the peer
	*     persisted only after the turn ended never streams live, so the query is
	*     the only way to discover it.
	*
	* The caller supplies NONE of these values — it cannot know what the plugin
	* has actually observed.
	*/
	async #interactionSnapshot(connection, subscriptions, deviceId, sessionId, interactionId) {
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			if (String(entry["kind"] ?? "") !== "interaction.updated") continue;
			const payload = isRecord(entry["payload"]) ? entry["payload"] : {};
			if (optionalString(payload["interactionId"]) !== interactionId) continue;
			this.#rememberInteraction(deviceId, sessionId, payload);
		}
		const streamed = this.#interactionCache.get(this.#interactionKey(deviceId, sessionId, interactionId));
		if (streamed !== void 0) return streamed;
		const page = await this.#aggregate(connection, "agent.interactions.list", { sessionId }, (result) => ({
			items: arrayOf(result["items"]),
			nextCursor: result["nextCursor"]
		}), MAX_AGGREGATE_LIMIT, MAX_AGGREGATE_LIMIT, INTERACTIONS_LIST_PAGE_CLAMP);
		for (const item of page.items) this.#rememberInteraction(deviceId, sessionId, item);
		return this.#interactionCache.get(this.#interactionKey(deviceId, sessionId, interactionId));
	}
	/**
	* Records one interaction's staleness snapshot from a wire view.
	*
	* A PENDING interaction also refreshes the session's active-execution cache,
	* because the run it blocks is by definition still in flight. A SETTLED
	* (approved/denied/expired) one deliberately does NOT: its execution may have
	* finished long ago, and recording it would make `cherry_cancel` name a dead
	* run and turn an idle session into a peer-side CONFLICT instead of the
	* in-band `no-active-execution`.
	*/
	#rememberInteraction(deviceId, sessionId, raw) {
		const interactionId = optionalString(raw["interactionId"]);
		const revision = optionalString(raw["revision"]);
		const executionId = optionalString(raw["executionId"]);
		const inputDigest = optionalString(raw["inputDigest"]);
		if (interactionId === void 0 || revision === void 0 || executionId === void 0) return;
		if (inputDigest === void 0) return;
		this.#interactionCache.set(this.#interactionKey(deviceId, sessionId, interactionId), {
			revision,
			executionId,
			inputDigest
		});
		if (raw["status"] === "pending") this.#executionCache.set(this.#cacheKey(deviceId, sessionId), executionId);
	}
	/**
	* The session's current cursor, for a result that has to say where to resume.
	* Read from the subscription cache without advancing the ACK cursor —
	* waiters CONSUME, they do not acknowledge (controller ruling: ack stays the
	* `cherry_events` delivery call site).
	*/
	#cursorOf(subscriptions, sessionId) {
		const result = subscriptions.read(sessionId);
		return "events" in result ? result.nextCursor : void 0;
	}
	/**
	* The cursor a re-ensure should resume a MID-WAIT session from.
	*
	* It CANNOT be {@link #cursorOf} at the moment of recovery: the subscription
	* is gone by definition, so `read` answers `cursor-out-of-window` and there is
	* no layer cursor left to ask for. So the cursor is CARRIED — the last one the
	* layer handed out while the session was still live, captured on every pass of
	* the wait.
	*
	* Carrying it matters because the two recovery modes are NOT equivalent for a
	* waiter. A cursor lets the peer REPLAY, so the events that arrived while the
	* stream was down reach the fold as events — which is all `#observedState`
	* understands. A cursorless ensure lands in checkpoint mode instead, which
	* rebuilds peer-side STATE and delivers no events at all: the run could settle
	* and this wait would never see it. The carried cursor keeps the recovery on
	* the replay path.
	*
	* It is only usable while its EPOCH still matches: a re-subscribe creates a
	* new peer-side stream, and offering a foreign epoch is refused as "epoch
	* changed". That refusal is not a hazard — the layer answers it by falling
	* back to a checkpoint, which is the same place the cursorless call would have
	* landed — so the stale-epoch cursor is passed through rather than guessed
	* about here.
	*/
	#resumeCursorOf(carried) {
		return carried;
	}
	/**
	* The wait's terminal answer when its event stream could not be rebuilt.
	*
	* A RESULT, not a throw: the run is almost certainly fine — it is this
	* harness's VIEW of it that was lost — and a caller that can read the session
	* back (`cherry_read` needs no subscription) has everything it needs to
	* recover. The `guidance` says so in one sentence, because a bare status name
	* leaves the caller with no next step.
	*
	* The execution id is still reported whenever the wait had attached to one,
	* so a caller can re-wait on it or read it back by id rather than guess.
	*/
	#subscriptionLostResult(sessionId, executionId, commandId, reason) {
		console.warn(`[cherry-remote] wait on session ${sessionId} lost its event subscription and could not re-establish it (${reason || "the session is no longer tracked"}); reporting subscription-lost rather than inventing a timeout`);
		return {
			status: "subscription-lost",
			sessionId,
			executionId: executionId ?? null,
			...commandId === void 0 ? {} : { commandId },
			reason: reason === "" ? "the session is no longer tracked" : reason,
			guidance: SUBSCRIPTION_LOST_GUIDANCE
		};
	}
	/**
	* The waiter: parks until the session's EXECUTION reaches one of the four
	* terminal states, an unanswered interaction makes the run a SOFT terminal,
	* or the window elapses.
	*
	* The predicate covers the execution dimension ONLY. A command receipt's
	* `interrupted` — where the command's outcome is undecided — is a different
	* dimension and deliberately does NOT settle a wait (Task 13 asserts the two
	* layers separately).
	*
	* Waiters never ack: they consume the projection and leave the peer's view
	* untouched.
	*
	* A wait can also end because the LINK went away — the plugin was torn down,
	* the device was unpaired, or the connection closed. That is not a timeout and
	* not a terminal state: the run's outcome is simply unknowable, so the wait
	* FAILS FAST with the established {@link DeviceUnavailableError} rather than
	* parking out its whole window. Without this check a torn-down pool's parked
	* waiter would sit for the full timeout (120s by default), because `waitFor`'s
	* rejection — the disposal signal — is deliberately swallowed below.
	*/
	async #awaitRun(connection, subscriptions, sessionId, options) {
		const deadline = options.startedAt + options.timeoutMs;
		let latestExecutionId = options.executionId;
		const baselineSeq = options.baselineSeq ?? this.#newestSeq(subscriptions, sessionId);
		const observation = {};
		let reEnsureAttempted = false;
		let reEnsureFailure = "";
		let carriedCursor;
		for (;;) {
			if (connection.state !== "connected") throw new DeviceUnavailableError(connection.record.deviceId, connection.state);
			if (!subscriptions.activeSessions().includes(sessionId)) {
				if (reEnsureAttempted) return this.#subscriptionLostResult(sessionId, latestExecutionId, options.commandId, reEnsureFailure);
				reEnsureAttempted = true;
				try {
					await subscriptions.ensure(sessionId, this.#resumeCursorOf(carriedCursor));
				} catch (error) {
					reEnsureFailure = error instanceof Error ? error.message : String(error);
					return this.#subscriptionLostResult(sessionId, latestExecutionId, options.commandId, reEnsureFailure);
				}
				continue;
			}
			const observed = this.#observedState(subscriptions, sessionId, {
				baselineSeq,
				carry: observation,
				...latestExecutionId === void 0 ? {} : { awaitedExecutionId: latestExecutionId }
			});
			if (observed.executionId !== void 0) latestExecutionId = observed.executionId;
			const pending = observed.pendingInteractions[0];
			if (pending !== void 0) return {
				status: "awaiting-interaction",
				sessionId,
				executionId: observed.executionId ?? options.executionId ?? null,
				...options.commandId === void 0 ? {} : { commandId: options.commandId },
				interactionId: pending.interactionId,
				kind: pending.kind,
				summary: pending.summary,
				questions: pending.questions,
				pendingInteractions: observed.pendingInteractions,
				cursor: this.#cursorOf(subscriptions, sessionId)
			};
			if (observed.terminalStatus !== void 0) return await this.#terminalResult(connection, subscriptions, sessionId, observed.terminalStatus, {
				...latestExecutionId === void 0 ? {} : { executionId: latestExecutionId },
				...options.commandId === void 0 ? {} : { commandId: options.commandId },
				...observed.terminalMessageId === void 0 ? {} : { terminalMessageId: observed.terminalMessageId }
			});
			const now = performance.now();
			if (now >= deadline) return await this.#timeoutResult(connection, subscriptions, sessionId, {
				timeoutMs: options.timeoutMs,
				...latestExecutionId === void 0 ? {} : { executionId: latestExecutionId },
				...options.commandId === void 0 ? {} : { commandId: options.commandId }
			});
			const cursor = this.#cursorOf(subscriptions, sessionId);
			if (cursor !== void 0) carriedCursor = cursor;
			const pollMs = Math.min(this.#waitPollMs, Math.max(1, deadline - now));
			const park = subscriptions.waitFor(sessionId, cursor);
			try {
				if (!await Promise.race([park.promise.then(() => true, () => false), sleep(pollMs).then(() => true)])) await sleep(pollMs);
			} finally {
				park.dispose();
			}
		}
	}
	/**
	* The session's observed execution/interaction state, as the real-time event
	* stream has reported it.
	*
	* Two scoping rules make this correct across CONSECUTIVE runs on one session
	* (the session buffer is cumulative and an ack does not shrink it, so a naive
	* replay would re-see every prior run's terminal):
	*
	*  1. **A terminal is attributed to its own execution.** `terminalStatus` is
	*     reported ONLY for `awaitedExecutionId`; every other execution's terminal
	*     is ignored. This is the fix for the stale-terminal bug — a second send
	*     on one session must not read the FIRST run's `completed` and return
	*     while its own run is still in flight.
	*  2. **Only terminals are cut at the baseline; pendings never are.** The
	*     baseline excludes an execution that settled BEFORE this wait began, but
	*     a still-unanswered interaction is not history — it is exactly the soft
	*     terminal the waiter exists to report, so it must stay visible however
	*     long it has been pending.
	*  3. **A wait with no id ADOPTS the first post-baseline run.** See
	*     {@link CherryToolEngine.#adoptExecution}.
	*
	* `terminalStatus` is the closed four-state set; the receipt dimension's
	* `interrupted` never lands here.
	*
	* `pendingInteractions` is a SET, not a slot: the soft-terminal predicate is
	* "ANY unanswered pending interaction" (spec §3.6), so two pendings where the
	* later-registered settles first must leave the earlier one visible.
	*
	* INCREMENTAL BY DESIGN. The fold is cumulative over the session buffer, which
	* only ever APPENDS, so re-reading it from index 0 on every poll pass is
	* wasted work that grows with the run's length. `carry` is the fold state from
	* the previous pass; when supplied, only entries with a seq above
	* `carry.scannedSeq` are folded, and the pending map / settled set / terminal
	* observation are inherited rather than rebuilt. The semantics are IDENTICAL —
	* the same events are folded in the same order, exactly once — because the
	* buffer preserves order and `scannedSeq` only ever moves forward.
	*
	* A caller with no carry (the first pass) simply folds everything, which is
	* still linear in the buffer once.
	*/
	#observedState(subscriptions, sessionId, options) {
		const state = { pendingInteractions: [] };
		const awaited = options.awaitedExecutionId ?? options.carry?.awaited ?? this.#adoptExecution(subscriptions, sessionId, options.baselineSeq);
		const pending = options.carry?.pending ?? /* @__PURE__ */ new Map();
		const settledBeforeBaseline = options.carry?.settledBeforeBaseline ?? /* @__PURE__ */ new Set();
		const scannedSeq = options.carry?.scannedSeq;
		state.executionId = options.carry?.executionId;
		state.terminalStatus = options.carry?.terminalStatus;
		state.terminalMessageId = options.carry?.terminalMessageId;
		let scannedSeqNext = scannedSeq ?? -Infinity;
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			const seq = Number(entry["seq"]);
			if (scannedSeq !== void 0 && Number.isFinite(seq) && seq <= scannedSeq) continue;
			if (Number.isFinite(seq) && seq > scannedSeqNext) scannedSeqNext = seq;
			const beforeBaseline = !Number.isFinite(seq) || seq <= options.baselineSeq;
			const kind = String(entry["kind"] ?? "");
			const payload = isRecord(entry["payload"]) ? entry["payload"] : {};
			if (kind === "interaction.updated") {
				const interactionId = optionalString(payload["interactionId"]);
				const status = optionalString(payload["status"]);
				if (interactionId === void 0) continue;
				if (status !== "pending") {
					pending.delete(interactionId);
					continue;
				}
				pending.set(interactionId, {
					interactionId,
					kind: optionalString(payload["kind"]) ?? "decision",
					summary: String(payload["summary"] ?? ""),
					questions: questionKeysOf(payload["input"])
				});
				continue;
			}
			if (kind !== "execution.updated") continue;
			const executionId = optionalString(payload["executionId"]);
			const status = optionalString(payload["status"]);
			if (executionId === void 0 || status === void 0) continue;
			const terminal = TERMINAL_EXECUTION_STATUSES.includes(status);
			if (beforeBaseline) {
				if (terminal) settledBeforeBaseline.add(executionId);
				continue;
			}
			if (awaited === void 0 || executionId !== awaited) continue;
			state.executionId = executionId;
			state.terminalStatus = terminal ? status : void 0;
			if (terminal) state.terminalMessageId = optionalString(payload["messageId"]);
		}
		if (state.terminalStatus === void 0 && awaited !== void 0 && settledBeforeBaseline.has(awaited) && pending.size === 0) {
			const settled = this.#settledStatusOf(subscriptions, sessionId, awaited, options.baselineSeq);
			state.terminalStatus = settled.status;
			state.terminalMessageId = settled.messageId;
			state.executionId = awaited;
		}
		state.pendingInteractions = [...pending.values()];
		if (options.carry !== void 0) {
			options.carry.pending = pending;
			options.carry.settledBeforeBaseline = settledBeforeBaseline;
			options.carry.awaited = awaited;
			options.carry.executionId = state.executionId;
			options.carry.terminalStatus = state.terminalStatus;
			options.carry.terminalMessageId = state.terminalMessageId;
			options.carry.scannedSeq = Number.isFinite(scannedSeqNext) ? scannedSeqNext : void 0;
		}
		return state;
	}
	/**
	* The execution a wait with NO id should attach to: the first
	* `execution.updated` that arrived strictly after `baselineSeq`, or undefined
	* when no run has appeared yet.
	*
	* This is the "receipt did not name the run" recovery (see
	* {@link CherryToolEngine.#observedState}'s rule 3). The BASELINE is what
	* makes it sound rather than a guess: an execution whose only events sit at or
	* before the cut belongs to a run that was already under way when this wait
	* began, so it cannot be the run this command is about to start.
	*
	* "First" means first in the buffer's own order — the buffer is append-ordered
	* by construction, so this is the earliest post-baseline run, not whichever
	* event happens to be newest.
	*
	* ACCEPTED BOUND (adjudicated, no behavior change): both this scan and
	* {@link CherryToolEngine.#settledStatusOf} read the session buffer, which the
	* subscription layer TRIMS to its per-session byte budget by dropping the
	* OLDEST events. Once a run's `execution.updated` has been trimmed away, the
	* id it named is no longer knowable from here, so a wait that has not yet
	* attached to that run degrades to what it would have been without adoption at
	* all: it parks out its window and answers `timeout` (with the partial content
	* and the resume cursor, per spec §6) rather than `completed`. The bound is
	* therefore ~2 MiB of buffered events per session — the default budget — and
	* reaching it takes a run that both emits that much event traffic AND whose
	* command receipt omitted `executionId`. The degradation is bounded and
	* recoverable rather than silent: `timeout` is a non-failure answer, and
	* `cherry_read` rebuilds the full picture without the buffer.
	*
	* It is NOT fixed by scanning the peer's journal, because the peer's replay
	* window is itself bounded and the tool has no cursor to offer it — the same
	* trim would simply move one layer down, at the cost of an RPC on every pass.
	*/
	#adoptExecution(subscriptions, sessionId, baselineSeq) {
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			if (String(entry["kind"] ?? "") !== "execution.updated") continue;
			const seq = Number(entry["seq"]);
			if (Number.isFinite(seq) && seq <= baselineSeq) continue;
			const executionId = optionalString((isRecord(entry["payload"]) ? entry["payload"] : {})["executionId"]);
			if (executionId !== void 0) return executionId;
		}
	}
	/**
	* The terminal an awaited execution settled on at or before the baseline, or
	* undefined when it never settled. Only consulted for an awaited execution
	* that was already over when the wait began — the "I am waiting on a run that
	* has already finished" case `cherry_wait` must answer rather than park on.
	*/
	#settledStatusOf(subscriptions, sessionId, executionId, baselineSeq) {
		let settled = {};
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			if (String(entry["kind"] ?? "") !== "execution.updated") continue;
			const seq = Number(entry["seq"]);
			if (Number.isFinite(seq) && seq > baselineSeq) continue;
			const payload = isRecord(entry["payload"]) ? entry["payload"] : {};
			if (optionalString(payload["executionId"]) !== executionId) continue;
			const status = optionalString(payload["status"]);
			if (status !== void 0 && TERMINAL_EXECUTION_STATUSES.includes(status)) settled = {
				status,
				messageId: optionalString(payload["messageId"])
			};
		}
		return settled;
	}
	/**
	* The session's buffered events as raw views, oldest first — read through the
	* subscription layer's own `read` with NO cursor, so nothing is consumed and
	* no waiter can disturb the delivery ack.
	*
	* This is the real-time view the soft-terminal predicate is defined over
	* (spec §3.6: 「经实时 `interaction.updated` 入流」). It is deliberately NOT
	* `projection()`, which carries checkpoint-rebuilt STATE rather than stream
	* events and so has no notion of what arrived live.
	*
	* `seq` is preserved on each view — {@link CherryToolEngine.#observedState}
	* needs it to cut the fold at a baseline.
	*/
	#eventsOf(subscriptions, sessionId) {
		const result = subscriptions.read(sessionId);
		if (!("events" in result)) return [];
		return result.events.map((event) => event);
	}
	/**
	* The newest stream seq the session buffer holds — the baseline a waiter
	* captures at its start, so its fold sees only events that arrive AFTER it.
	*/
	#newestSeq(subscriptions, sessionId) {
		const events = this.#eventsOf(subscriptions, sessionId);
		let newest = 0;
		for (const entry of events) {
			const seq = Number(entry["seq"]);
			if (Number.isFinite(seq) && seq > newest) newest = seq;
		}
		return newest;
	}
	/**
	* The terminal aggregate: the run's status plus the assistant text THIS RUN
	* produced, with `{ref}` parts resolved through the same externalized content
	* walk `cherry_read` uses.
	*
	* `text` is RUN-SCOPED (spec §3.6: 「终态后聚合助手最终消息文本」). The session
	* history is cumulative and the peer appends a FRESH assistant message per
	* run, so concatenating every assistant message would re-deliver a prior
	* run's reply on the second send of a reused session — the primary workflow.
	* The cut is the terminal's own `messageId` when the peer named one (the
	* waiter carries it from `execution.updated`); without that name the text
	* falls back to the NEWEST assistant message (see
	* {@link aggregateAssistantText}). Either way the `messages` array stays on
	* the result as context, bounded by {@link TERMINAL_AGGREGATE_MESSAGES} and
	* {@link TERMINAL_AGGREGATE_BYTES}.
	*
	* A CONTENT ASSEMBLY FAILURE DOES NOT UNDO THE VERDICT (issue #3). The run
	* really did settle on `status`; only the history read behind `text` failed.
	* Throwing would take the status and the run's identifiers down with it —
	* the field report could not even recover the `commandId` of the command it
	* had just issued. So the failure DEGRADES to a stub receipt: the verdict,
	* the session, the execution/command ids and the event cursor, plus
	* `aggregateError` and `guidance`, and NO `messages`/`text` (half an
	* assembly must never be presented as the run's output).
	*/
	async #terminalResult(connection, subscriptions, sessionId, status, extra) {
		const { terminalMessageId, ...rest } = extra;
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const idle = optionalString(session["idleRevision"]) ?? optionalString(session["historyRevision"]);
		if (idle !== void 0) this.#revisionCache.set(this.#cacheKey(connection.record.deviceId, sessionId), idle);
		const cursor = this.#cursorOf(subscriptions, sessionId);
		const assembled = await this.#assembledTerminalMessages(connection, sessionId, session, {
			status,
			sessionId,
			...rest,
			cursor
		});
		if (assembled.failed !== void 0) return assembled.failed;
		return {
			status,
			sessionId,
			...rest,
			session,
			text: aggregateAssistantText(assembled.messages, typeof terminalMessageId === "string" ? terminalMessageId : void 0),
			messages: assembled.messages,
			cursor,
			...assembled.walk
		};
	}
	/**
	* The timeout result: NOT a failure. Partial content read so far + the
	* cursor to resume from.
	*
	* Unlike the terminal aggregate the text here is NOT run-scoped: the run has
	* not settled, so there is no terminal message to cut at, and the whole point
	* of the timeout answer is to hand back the PARTIAL content produced so far
	* (spec §3.6: 超时非失败返回部分内容+游标).
	*
	* WHERE THE PARTIAL CONTENT ACTUALLY LIVES — and therefore how honest `text`
	* is. A run that has not settled has usually not committed anything to the
	* HISTORY face yet: on the real peer the assistant message exists as a
	* pending row whose `parts` are still empty, and the tokens stream on the
	* EVENT channel as `part.append` events. So a timeout's `text` is very often
	* `''`, and that empty string is the truthful answer: the newest assistant
	* message — this run's — has no parts in the history face. The content is in
	* the event stream, which is where `part.append` carries it; it reaches the
	* history face (and this aggregate) only when the run commits. The fallback
	* anchor is the NEWEST assistant message for exactly this reason: an older
	* message's text would say "this is your run's output" about a run that has
	* produced none. See {@link aggregateAssistantText}.
	*
	* The result also carries `progress` — a zero-round-trip HEARTBEAT: the
	* newest event already in this session's subscription buffer, with its kind.
	* It costs no RPC (the waiter holds the buffer) and it is the one thing that
	* lets a caller tell "the run is still moving" from "the stream went silent"
	* without a second call. Its limits are stated where it is built
	* ({@link CherryToolEngine.#timeoutProgress}).
	*/
	async #timeoutResult(connection, subscriptions, sessionId, extra) {
		const sessionResult = await connection.rpc.request("agent.sessions.get", { sessionId });
		const session = isRecord(sessionResult["session"]) ? sessionResult["session"] : {};
		const cursor = this.#cursorOf(subscriptions, sessionId);
		const progress = this.#timeoutProgress(subscriptions, sessionId);
		const assembled = await this.#assembledTerminalMessages(connection, sessionId, session, {
			status: "timeout",
			sessionId,
			...extra,
			cursor,
			...progress === void 0 ? {} : { progress }
		});
		if (assembled.failed !== void 0) return assembled.failed;
		return {
			status: "timeout",
			sessionId,
			...extra,
			session,
			text: aggregateAssistantText(assembled.messages),
			messages: assembled.messages,
			cursor,
			...progress === void 0 ? {} : { progress },
			...assembled.walk
		};
	}
	/**
	* The timeout answer's HEARTBEAT: the newest event the session's own
	* subscription buffer already holds, and its kind.
	*
	* ZERO ROUND TRIPS BY CONSTRUCTION. The waiter has been folding this buffer
	* every poll pass, so the newest entry is already in hand; asking the peer
	* (`agent.sessions.get`, a journal read) for the same fact would spend the
	* caller's window on a second RPC at the exact moment the first one is
	* already late — and would re-introduce the unbounded-ring-time defect this
	* result is being fixed for. Both numbers are read from one scan of the
	* buffer's tail, so they always describe the SAME event.
	*
	* ITS LIMITS, stated here rather than discovered by a caller:
	*
	*  - **Omitted when the buffer is empty.** An epoch rotation (a
	*    `resetRequired`, a re-subscribe, an LRU eviction) drops the buffer
	*    WHOLESALE, and a session with no event traffic at all starts empty. In
	*    both cases there is no event to report, so the field is ABSENT — never a
	*    zero or an invented seq, which a caller would read as "the stream is at
	*    position 0" and conclude the opposite of what is true.
	*  - **It is not a liveness PROOF, only a liveness HINT.** `seq` is this
	*    session's stream position, so an unchanged `lastEventSeq` across two
	*    timeouts means no event arrived in between — the stream is quiet, not
	*    that the run is dead (a run can legitimately emit nothing for a while).
	*    A CHANGED `lastEventSeq` is the strong signal: the run (or the session)
	*    is producing events.
	*  - **The buffer is bounded per session** (the subscriptions layer trims it
	*    to a byte budget by dropping the OLDEST events). That only ever hides
	*    old events, and the heartbeat reads the newest.
	*/
	#timeoutProgress(subscriptions, sessionId) {
		let newest;
		let newestSeq = Number.NEGATIVE_INFINITY;
		for (const entry of this.#eventsOf(subscriptions, sessionId)) {
			const seq = Number(entry["seq"]);
			if (!Number.isFinite(seq) || seq <= newestSeq) continue;
			newest = entry;
			newestSeq = seq;
		}
		if (newest === void 0) return void 0;
		return {
			lastEventSeq: newestSeq,
			lastEventKind: String(newest["kind"] ?? "")
		};
	}
	/**
	* The bounded history read the three wait answers share, with its two
	* possible outcomes folded into one type:
	*
	*  - the projection succeeded → `messages` + the walk verdict (which may
	*    itself say the walk was bounded or byte-capped — surfaced, never
	*    silent);
	*  - the projection FAILED → `failed`, the STUB RECEIPT the caller returns
	*    verbatim (issue #3): the verdict and the identifiers already collected
	*    in `identity`, plus `aggregateError` and `guidance`, and no content.
	*
	* Failure does not distinguish an integrity error from a transport fault
	* here, deliberately: `cherry_read`'s rule (an unverifiable `{ref}` fails the
	* WHOLE read) is about not presenting unverified content as a snapshot, and
	* that rule still holds — `cherry_read` still throws. A WAIT is a different
	* question: the run's verdict is already known and must survive, so here the
	* same failure degrades the CONTENT (`messages`/`text` absent) while the
	* verdict stands. Nothing unverified is handed back either way.
	*/
	async #assembledTerminalMessages(connection, sessionId, session, identity) {
		try {
			const { messages, ...walk } = await this.#readTerminalMessages(connection, sessionId, session);
			return {
				messages,
				walk
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[cherry-remote] the ${String(identity["status"])} answer for session ${sessionId} could not assemble its content (${message}); returning the verdict with the assembly failure reported`);
			return { failed: {
				...identity,
				aggregateError: message.slice(0, 200),
				guidance: AGGREGATE_FAILED_GUIDANCE
			} };
		}
	}
	/**
	* The session's recent messages, projected with `{ref}` parts aggregated
	* through `agent.content.read` — the SAME projection `cherry_read` uses
	* (spec §3.6: the terminal aggregate resolves externalized parts too).
	*
	* BOUNDED, in two dimensions (issue #3):
	*
	*  1. **Messages** — at most {@link TERMINAL_AGGREGATE_MESSAGES}, starting
	*     from the NEWEST page. The peer's `listSessionMessages` walks
	*     newest-first, so the walk reaches the current run's own messages first;
	*     history past the ceiling is not what a wait is asking for.
	*  2. **Bytes** — the projected messages are accumulated (their
	*     `JSON.stringify` length as a wire-cost proxy) and the projection stops
	*     once {@link TERMINAL_AGGREGATE_BYTES} is exceeded. The message COUNT
	*     alone bounds nothing: one message may carry hundreds of parts, each a
	*     separate `agent.content.read`.
	*
	* The FIRST message is always projected and always kept WHOLE — it is the
	* newest, i.e. the run's own reply — so the byte budget is only ever checked
	* AFTER a complete message has been taken. A walk that stopped for either
	* reason comes back with the verdict filled in (`messageWalkVerdict`
	* handles the ceiling; `'aggregate-bytes'` is attributed here), and the
	* three callers (terminal, timeout, idle) each surface it.
	*/
	async #readTerminalMessages(connection, sessionId, session) {
		const historyRevision = optionalString(session["historyRevision"]);
		if (historyRevision === void 0) return { messages: [] };
		const page = await this.#aggregate(connection, "agent.messages.list", {
			sessionId,
			historyRevision
		}, (result) => ({
			items: arrayOf(result["items"]),
			nextCursor: result["nextCursor"]
		}), TERMINAL_AGGREGATE_MESSAGES);
		const messages = [];
		let projectedBytes = 0;
		let outOfBudget = false;
		for (const raw of page.items) {
			const message = await this.#projectMessage(connection, sessionId, raw);
			messages.push(message);
			projectedBytes += JSON.stringify(message).length;
			if (projectedBytes >= TERMINAL_AGGREGATE_BYTES) {
				outOfBudget = true;
				break;
			}
		}
		if (outOfBudget && (messages.length < page.items.length || page.truncated)) return {
			messages,
			messagesTruncated: true,
			messagesTruncationReason: "aggregate-bytes",
			...page.nextCursor === void 0 ? {} : { messagesResumeCursor: page.nextCursor }
		};
		return {
			messages,
			...messageWalkVerdict(page)
		};
	}
	async #ensureSubscription(deviceId, sessionId) {
		const subscriptions = this.#deps.subs(deviceId);
		if (subscriptions.activeSessions().includes(sessionId)) return;
		await subscriptions.ensure(sessionId);
	}
	/**
	* The session's current cache window start, or null when it is untracked.
	*
	* The subscriptions layer OWNS this boundary and now exposes it directly
	* (`windowStart(sessionId)`), so the tool reads it instead of rediscovering
	* it. It used to reconstruct the value from the outside by probing `read`
	* with candidate cursors, which was worse in every dimension: the probe
	* compared seqs as NUMBERS while the verdict compares them numerically too,
	* but it could not tell "below the window" apart from "wrong stream epoch",
	* and it scanned upward one seq at a time, so a session whose window start
	* was far above 0 walked the whole interval.
	*
	* The read-only accessor is the same adjudication `subscriptions.ts` records
	* for its own boundary (controller ruling in commit f2b852b): the layer is
	* the only thing that knows the window start, so it publishes it rather than
	* leaving callers to rediscover it.
	*
	* `streamEpoch` is reported from the LAYER's current epoch rather than from
	* the caller's stale cursor: the verdict is about what can be served NOW, and
	* echoing a foreign epoch back would name a stream this session never had.
	*/
	#windowStart(subscriptions, sessionId) {
		return subscriptions.windowStart(sessionId) ?? null;
	}
};
/** The array at `value`, or an empty array when the peer sent something else. */
function arrayOf(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord);
}
/** The caller's aggregate limit, defaulting to one page and capped at the max. */
function aggregateLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return PAGE_ITEMS_FALLBACK;
	return Math.min(Math.max(Math.floor(value), 1), MAX_AGGREGATE_LIMIT);
}
/** Parses the tool-facing cursor argument into the protocol's cursor shape. */
function readCursor(value) {
	if (!isRecord(value)) return void 0;
	const { sessionId, streamEpoch, seq } = value;
	if (typeof sessionId !== "string" || typeof streamEpoch !== "string" || typeof seq !== "string") return void 0;
	return {
		sessionId,
		streamEpoch,
		seq
	};
}
/** A cancellable-free sleep, used only to bound a waiter's judgement cadence. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* The caller's wait window in ms, defaulting to {@link DEFAULT_WAIT_TIMEOUT_MS}.
*
* The default is a DEFAULT, never a ceiling (spec §3.6): a caller may raise or
* lower it freely, and the only floor is {@link MIN_WAIT_TIMEOUT_MS} — below
* that a "wait" would be a snapshot read wearing a wait's name.
*/
function waitTimeout(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS;
	return Math.max(MIN_WAIT_TIMEOUT_MS, Math.floor(value));
}
/**
* The question TEXTS an interaction asks its answers to be keyed by.
*
* The protocol carries a question interaction's input as serialized JSON under
* `input.text` (or an externalized `input.ref`), with the shape
* `{questions: [{question, options, ...}]}`. A caller answering by question
* text should not have to parse that itself, so the texts are surfaced.
*/
function questionKeysOf(input) {
	const parsed = parseQuestionInput(input);
	if (parsed === void 0) return [];
	return parsed;
}
/**
* Extracts the ordered question texts from an interaction input, if any.
*
* BEST-EFFORT BY DESIGN, and the `{ref}` branch is where that shows. The peer
* externalizes an interaction input above 4 KiB into a `{ref}`, and resolving
* one needs an `agent.content.read` round trip this pure parse has no way to
* make. So a `{ref}` input yields `undefined` and the caller gets an EMPTY
* question list.
*
* What that means for a caller is worth stating plainly: a question card whose
* input was externalized is UNANSWERABLE through the tool face today, because
* `cherry_respond`'s `response` form is keyed by question TEXT and there is no
* text to key by. The card is still visible (`cherry_interactions` reports its
* id, kind and summary) and a `decision` card is unaffected — its answer is the
* `decision` field, not a per-question map. Resolving `{ref}` inputs through the
* SAME externalized-content walk `cherry_read` uses is the deferred fix
* (adjudicated: documented best-effort now, `content.read` resolution later),
* and it is deferred rather than half-done because an unverified ref must never
* be presented as an answer key.
*/
function parseQuestionInput(input) {
	if (!isRecord(input)) return void 0;
	let body;
	if (typeof input["text"] === "string") try {
		body = JSON.parse(input["text"]);
	} catch {
		return;
	}
	else if (isRecord(input["ref"])) return;
	else body = input;
	if (!isRecord(body) || !Array.isArray(body["questions"])) return void 0;
	return body["questions"].map((question) => isRecord(question) ? optionalString(question["question"]) : void 0).filter((question) => question !== void 0);
}
/**
* The message-walk verdict, projected off an aggregate page.
*
* Extracted so the three non-`cherry_read` walkers ({@link
* CherryToolEngine.#readTerminalMessages}) report truncation in EXACTLY the
* shape `cherry_read` already does, from one place: a second, independently
* worded projection is how the terminal face and the read face drift apart
* again. Absent fields (rather than `false`/`undefined` keys) keep a complete
* walk's result shape unchanged for existing callers.
*/
function messageWalkVerdict(page) {
	if (!page.truncated) return {};
	return {
		messagesTruncated: true,
		...page.truncationReason === void 0 ? {} : { messagesTruncationReason: page.truncationReason },
		...page.nextCursor === void 0 ? {} : { messagesResumeCursor: page.nextCursor }
	};
}
/**
* The assistant text a terminal aggregate reports: the awaited RUN's assistant
* message text parts, joined.
*
* `{ref}` parts are already resolved by {@link CherryToolEngine}'s
* `#projectMessage` (the externalized content walk), so this only has to
* concatenate what the read produced.
*
* The scope is what makes this correct on a REUSED session: the peer appends a
* fresh assistant message per run and `messages.list` serves the cumulative
* history, so summing every assistant message would re-deliver run N-1's reply
* as run N's output. `terminalMessageId` — the message the awaited execution's
* terminal named — is the exact cut, and it is matched BY ID, so the array's
* order is irrelevant to it.
*
* ## The fallback anchors the NEWEST assistant message
*
* The array is NEWEST-FIRST. The peer's `listSessionMessages` "walks
* newest-first; an absent cursor returns the most recent page, each
* `nextCursor` walks one page older", so `messages[0]` is the most recent
* message in the session — which is why the fallback starts at index 0 and
* takes the first assistant message it meets.
*
* It used to anchor the array's TAIL, on the assumption that the protocol
* appended per run in read order. It does not: the tail is the OLDEST assistant
* message in the whole history, and the field defect was a 2026-10 run whose
* fallback text came from a July message. Anchoring the newest end is the exact
* inverse mistake — the right one, because the run this answer is about is the
* most recent thing the session produced.
*
* ## An empty string is a real answer
*
* On the TIMEOUT path the run is still in flight and has usually committed
* nothing to the history face: its assistant message exists as a pending row
* whose `parts` are empty, while the streamed tokens ride the EVENT channel as
* `part.append`. So the newest assistant message is the run's own, and it can
* legitimately have no text — `''` then says exactly that, where an older
* message's text would say "this is your run's output" about a run that has
* produced none. The partial content is in the event stream, not here.
*
* ## The scope is bounded, and that is flagged
*
* The walk this reads was bounded by the caller
* (`TERMINAL_AGGREGATE_MESSAGES` / `TERMINAL_AGGREGATE_BYTES`), so on a long
* session the text is assembled from the newest window only. When even that
* window was cut, the result carries the walk verdict
* ({@link CherryMessageWalkVerdict}) and `terminalMessageId` may fall outside
* it — both leave the text partial or stale, and neither may be presented as a
* complete answer.
*/
function aggregateAssistantText(messages, terminalMessageId) {
	const scoped = terminalMessageId === void 0 ? newestAssistantMessage(messages) : messages.filter((message) => message.messageId === terminalMessageId);
	const chunks = [];
	for (const message of scoped) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (part.kind !== "text") continue;
			if (part.content === "") continue;
			chunks.push(part.content);
		}
	}
	return chunks.join("");
}
/**
* The session's NEWEST assistant message, as a one-element list (or empty).
*
* Index 0 is the newest: the peer serves the history newest-first (see
* {@link aggregateAssistantText}). Named for the direction it reads rather than
* for its position, because conflating the two is exactly the defect this
* replaced.
*/
function newestAssistantMessage(messages) {
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message !== void 0 && message.role === "assistant") return [message];
	}
	return [];
}
//#endregion
//#region src/toolScopeHost.ts
/**
* The host integration layer: capability tri-state, the injection gate, and the
* ONE assembly point where registration, hiding and the dispatch guard are born
* and die together (spec §6.2 + B7/B10/B17).
*
* Four decisions carry this file:
*
*  1. **The host is mounted, not merely constructed.** {@link ToolScopeHost.mount}
*     is the only entry point that installs anything, and it returns the only
*     release path. `apply()` calls it AFTER the assembly's root `ctx.effect`
*     and pushes the returned disposer into `state.disposers`, so the plugin's
*     existing teardown drains it — there is deliberately no second root effect.
*
*  2. **The capability probe runs at `mount()` time, off the plugin ROOT ctx's
*     `tools` face** — never inside the injected effect. `register`, `restrict`
*     and `schemas` are hard gates (missing any one ⇒ `unsupported`); `guard` is
*     NOT a gate (missing ⇒ the `visibility-only` degradation). Because the probe
*     does not depend on the injection arrival, "static capability missing" and
*     "injection not yet arrived" can hold at once — and the static failure wins.
*
*  3. **The injected effect owns the lifecycle of all four faces**: the tool
*     registrations, every agent's restriction layer, the single global guard,
*     and the two subscriptions. Its merged disposer unsubscribes FIRST (the
*     release side of `register`/`restrict` also emits `tools/change`, and a
*     recompute running in that window would re-install a layer whose disposer
*     the map no longer holds — an ownerless layer, unrecoverable under
*     intersection semantics), then clears the pending recheck timers (they are
*     the last thing outside a dispatch that could still reach into this
*     generation), then releases registrations, then restrictions, and finally
*     the guard (which notifies nobody).
*
*  4. **State ownership stays with {@link ToolScopeState}.** This module keeps
*     no copy of the document, the degradation set, the judgement generation or
*     the installed-layer records; it reads and writes them through the scope
*     state's own surface (`judgement` / `layer` / `setLayer` / `clearLayer` /
*     `invalidateDerived`), which is what makes `guard`'s "层在 ⇒ 拒绝" mirror
*     true by construction.
*
*  5. **Every trigger of a recompute round goes through ONE coalescing gate**
*     ({@link requestRound}, §4 ①'s 合并 / 置脏后补跑). The host emits
*     `tools/change` on BOTH sides of `register`/`restrict`, so this module's own
*     install and release work re-enters its own listener; the gate is what makes
*     that terminating — an in-flight round is never overlapped, the trigger only
*     marks it dirty, and the round runs one catch-up pass before it ends. The
*     ONLY abstention point is teardown (§4), which every entry checks.
*
* Deliberately NOT here (Task 6): the bounded recheck. The install/release
* criteria and the three subscriptions ARE here — every "completion" and
* "retry" they describe is reachable through `refresh()` (the config-save path)
* and through `tools/change`.
*/
/**
* The label of this subsystem's mount lifecycle — §6.2 spells it, and this is
* the ONLY place the string is written. The assembly point references the
* constant through `mount()`; no caller re-spells it.
*/
const EFFECT_LABEL = "cherry-remote.tool-scope()";
/** The neutral waiting wording: `pending` must never read as "the host refuses". */
const PENDING_REASON = "等待宿主注入 agents / workspaceRegistry";
/** `ready` means: the three static capabilities AND both injected services. */
const READY_REASON = "宿主能力齐备（tools.register / tools.restrict / tools.schemas）且 agents / workspaceRegistry 注入已到达";
/** The two dependency keys this subsystem gates on. They enter ONE `inject` call. */
const INJECT_KEYS = ["agents", "workspaceRegistry"];
/**
* D14's bounded recheck schedule: two attempts, then the state is left as it is.
*
* A `cwd` whose resolution did not CONCLUDE may well resolve a moment later —
* the registry was not ready, the directory was momentarily unreachable, or the
* `sessionIds` projection had not caught up. Anything past two attempts is an
* idle spin, which D14 forbids outright.
*/
const DEFAULT_RECHECK_DELAYS_MS = [250, 2e3];
/**
* Runs ONE aggregate registration entry — `register(ledgerCtx)` — and guarantees
* that a FAILED registration leaves nothing behind.
*
* The aggregate contract is `() => () => void`: the disposer is only ever handed
* back on SUCCESS. A factory that registers three tools and then throws (a host
* that refuses the fourth registration, or a name a previous assembly leaked)
* therefore leaves those three with NO handle at all — its own local disposers
* array never escapes, and no layer above it can release them. That is a leak
* the caller cannot clean up, so it is closed here, at the single entry point
* both the assembly and the fixtures go through: every `register()` disposer is
* ledgered, and a throw releases the partial set before it travels on.
*
* On success the ledger stays out of the way: the returned aggregate disposer
* owns every registration.
*/
function registerAtomically(ctx, register) {
	const releases = [];
	const tools = ctx.tools;
	const ledger = tools === void 0 ? ctx : { tools: { register: (definition) => {
		const release = tools.register(definition);
		releases.push(release);
		return release;
	} } };
	try {
		return register(ledger);
	} catch (error) {
		for (const release of releases.splice(0)) try {
			release();
		} catch {}
		throw error;
	}
}
/**
* The readable cause of a caught throw, for a message or a `degraded` note. A
* host that rejects with a plain value is reported verbatim rather than as
* `[object Object]`.
*/
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
function createToolScopeHost(deps) {
	const { scope } = deps;
	const names = deps.names;
	const log = deps.log ?? ((message, error) => console.warn(message, error));
	const recheckDelaysMs = deps.recheckDelaysMs ?? DEFAULT_RECHECK_DELAYS_MS;
	let root;
	let staticCapable = false;
	let mountTornDown = false;
	/** The effect run currently holding the four faces, if any. */
	let current;
	function probe(tools) {
		const missing = [];
		if (tools === void 0) missing.push("tools");
		else {
			if (typeof tools.register !== "function") missing.push("tools.register");
			if (typeof tools.restrict !== "function") missing.push("tools.restrict");
			if (typeof tools.schemas !== "function") missing.push("tools.schemas");
		}
		if (missing.length === 0) return {
			capable: true,
			reason: READY_REASON
		};
		return {
			capable: false,
			reason: `宿主缺 ${missing.join(" / ")}，无法做到“注册即可隐藏” ⇒ 这 ${names.length} 个工具一个都不注册（fail-closed）`
		};
	}
	function projectAgent(raw) {
		if (typeof raw !== "object" || raw === null) return void 0;
		const value = raw;
		const id = value.id;
		if (typeof id !== "string" || id === "") return void 0;
		const cwdValue = value.session?.header?.cwd;
		const cwd = typeof cwdValue === "string" && cwdValue !== "" ? cwdValue : void 0;
		const scopedTools = value.ctx?.tools;
		const restrict = scopedTools?.restrict;
		return {
			id,
			...cwd === void 0 ? {} : { cwd },
			...typeof restrict !== "function" ? {} : { restrict: (filter) => restrict.call(scopedTools, filter) }
		};
	}
	function liveAgents(state) {
		const service = state.agents;
		const list = service?.list;
		if (typeof list !== "function") return [];
		let raw;
		try {
			raw = list.call(service);
		} catch (error) {
			log("[cherry-remote] agents.list() 抛出；本轮按“没有 live agent”处理", error);
			return [];
		}
		if (!Array.isArray(raw)) return [];
		return raw.map((entry) => projectAgent(entry)).filter((agent) => agent !== void 0);
	}
	/**
	* The ONE reporting site of an unreadable global view.
	*
	* The carrier is §6.1's EXISTING `install` source — an installation that could
	* not be completed is exactly that degradation, and the five-value enum has no
	* member for "unreadable view" (no sixth is added) — together with the warn
	* channel. Reported, never silent.
	*/
	function noteUnobserved(cause, error) {
		scope.noteDegraded({
			source: "install",
			reason: `无参 schemas() 不可读：${cause}（本轮既不安装也不释放任何层——既有层保持不动，绝不因为读不到就放开隐藏；下一次重算 / 配置保存会重试）`
		});
		log("[cherry-remote] 无参 schemas() 不可读；本轮不做任何装层 / 释放动作（fail-closed）", error);
	}
	/**
	* The no-argument GLOBAL view of the tool registry — D12/B12①'s only
	* sanctioned observation source for a deny set.
	*
	* `schemas(agent)` is deliberately never used: that view is already filtered by
	* the agent's own layers, so deriving `deny` from it would re-admit the very
	* names this plugin hides.
	*
	* `undefined` means the view could NOT be read, and it is deliberately NOT the
	* same value as an empty `Set`:
	*
	*  - **observed empty** is B18③'s 观测集合为空 — nothing may be installed, while
	*    an existing layer is still maintained by the ordinary rules;
	*  - **failed to observe** must make NO layer-changing host call at all (see
	*    {@link targetDeny}): routing it through the empty-target branch would
	*    RELEASE the hiding layers of not-visible agents, i.e. fail open on an
	*    unreadable input — the opposite of the module's own `agents.list()`
	*    failure, which leaves layers installed (B7 calls "已注册未隐藏" the worst
	*    state; B9/B16 resolve unreadable inputs to the stricter side).
	*
	* Contained HERE because this runs inside the injected effect body, which a real
	* host may reach asynchronously (R16).
	*/
	function observeGlobalNames() {
		const tools = root?.tools;
		if (tools === void 0 || typeof tools.schemas !== "function") {
			noteUnobserved("宿主 tools.schemas 不可用");
			return;
		}
		try {
			const view = tools.schemas();
			return new Set((Array.isArray(view) ? view : []).map((definition) => definition?.name).filter((name) => typeof name === "string"));
		} catch (error) {
			noteUnobserved(describeError(error), error);
			return;
		}
	}
	/**
	* The pinned target set — the names this agent must HIDE — with one definition
	* and no second (B18):
	*
	*   visible under the CURRENT document and judgement ⇒ the EMPTY set
	*   not visible ⇒ CHERRY_TOOL_NAMES ∩ the no-argument `schemas()`
	*   not visible, view unreadable ⇒ `undefined` (no target could be computed)
	*
	* `judgement()` is the per-agent cache; a MISS falls back to
	* `scope.resolveNow(agent)` — the same §4 rules answered from the CURRENT
	* generation WITHOUT awaiting anything. `rebuild()` is fed by the currently
	* live agents alone, so a brand-new agent id can never be pre-judged; without
	* that fallback the first install would deny all 14 names and the tools would
	* appear only once the asynchronous round converged — B13's 「第一轮就有工具」
	* is exactly the other direction. Only when there is NO usable generation
	* either (a read never taken, failed, or empty) does the expression collapse
	* to `isVisible(doc, undefined)`: under `global` that is true (a miss releases
	* only), while under `selected` it is false — the D7 fail-closed side.
	* Visibility is derived from `isVisible`, never from `status === 'resolved'`,
	* and the `visible` arm needs no observation at all.
	*
	* An EMPTY set means RELEASE ONLY. `{ deny: [] }` is never submitted: the host
	* accepts it as a no-op layer admitting every name, which this plugin's guard
	* (layer present ⇒ reject) would misread as "already hidden" — tools visible
	* but rejected (B18③).
	*
	* `undefined` is NOT the empty set: the observation failed, so no target exists
	* and the caller must leave every installed layer exactly where it is.
	*/
	function targetDeny(agent) {
		const resolved = scope.judgement(agent.id) ?? scope.resolveNow(agent);
		if (isVisible(scope.doc(), resolved?.workspaceId)) return [];
		const observed = observeGlobalNames();
		return observed === void 0 ? void 0 : names.filter((name) => observed.has(name));
	}
	function reasonFor(agent) {
		const cached = scope.judgement(agent.id);
		if (cached !== void 0) return cached.reason;
		const sync = scope.resolveNow(agent);
		if (sync === void 0) return "判定缓存未命中（按 D7 fail-closed 隐藏；重算完成后按新判定补齐）";
		if (sync.workspaceId !== void 0) return sync.reason;
		return `判定缓存未命中（按 D7 fail-closed 隐藏；重算完成后按新判定补齐）；本窗口的同步判定：${sync.reason}`;
	}
	/** §4 ②'s 同名短路: two deny sets holding exactly the same names. */
	function sameDenySet(a, b) {
		return a.length === b.length && a.every((name) => b.includes(name));
	}
	/**
	* THE release path for one installed layer: EVERY caller — the release-only
	* arm of {@link applyForAgent}, `agent/disposed` and §6.2's teardown — goes
	* through here, so the containment rule has exactly one definition.
	*
	* A release the host refuses is unrecoverable (the layer may still be installed
	* while its record is already gone, so under intersection semantics it can
	* never be released again and only a DSH restart clears it), but it must not
	* travel into the caller either (B12②'s "不抛到调用方" is the same rule on both
	* sides of the pair). So it is contained AND recorded: a `log` alone would leave
	* the orphaned layer absent from `degraded` and from every diagnostics face.
	* The wording names the agent and the consequence.
	*/
	function disposeQuietly(agentId, dispose) {
		try {
			dispose();
		} catch (error) {
			scope.noteDegraded({
				source: "install",
				reason: `agent ${agentId} 的 restriction 释放失败（层可能仍在生效，仅重启 DSH 可清除）：${describeError(error)}`
			});
			log(`[cherry-remote] 释放 agent ${agentId} 的 restriction 失败`, error);
		}
	}
	function applyForAgent(state, agent) {
		const target = targetDeny(agent);
		const existing = state.layers.get(agent.id);
		if (target === void 0) return "skipped";
		if (target.length === 0) {
			if (existing === void 0) return "skipped";
			scope.clearLayer(agent.id);
			state.layers.delete(agent.id);
			disposeQuietly(agent.id, existing);
			return "released";
		}
		const record = scope.layer(agent.id);
		if (existing !== void 0 && record !== void 0 && sameDenySet(record.deny, target)) {
			const reason = reasonFor(agent);
			if (record.reason !== reason) scope.setLayer(agent.id, {
				deny: record.deny,
				reason
			});
			return "skipped";
		}
		if (agent.restrict === void 0) {
			scope.noteDegraded({
				source: "install",
				reason: `agent ${agent.id} 缺少 agent.ctx.tools.restrict，无法安装 restriction：目标工具保持可见且 guard 放行（无 scoped ctx 的 agent；配置保存 / 下一次重算会重试）`
			});
			log(`[cherry-remote] agent ${agent.id} 没有 agent.ctx.tools.restrict，无法安装 restriction；跳过该 agent`);
			return "skipped";
		}
		let dispose;
		try {
			dispose = agent.restrict({ deny: [...target] });
		} catch (error) {
			scope.noteDegraded({
				source: "install",
				reason: `agent ${agent.id} 的 restriction 安装被宿主拒绝：${describeError(error)}（该 agent 本轮未隐藏；下一次重算 / 配置保存会重试）`
			});
			log(`[cherry-remote] agent ${agent.id} 的 restriction 安装被宿主拒绝；本轮跳过该 agent`, error);
			return "skipped";
		}
		state.layers.set(agent.id, dispose);
		scope.setLayer(agent.id, {
			deny: [...target],
			reason: reasonFor(agent)
		});
		if (existing !== void 0) disposeQuietly(agent.id, existing);
		return "installed";
	}
	function applyAll(state) {
		const summary = {
			agents: 0,
			installed: 0,
			released: 0,
			skipped: 0
		};
		const agents = liveAgents(state);
		summary.agents = agents.length;
		for (const agent of agents) {
			const outcome = applyForAgent(state, agent);
			if (outcome === "installed") summary.installed += 1;
			else if (outcome === "released") summary.released += 1;
			else summary.skipped += 1;
		}
		return summary;
	}
	/**
	* The asynchronous half of one round: one judgement generation, then the same
	* (synchronous) install/release pass on top of it. Never rejects — a failed
	* round is recorded, never thrown into a `@mode serial` event dispatch.
	*/
	async function converge(state) {
		try {
			if (state.tornDown || mountTornDown) return;
			const registry = state.registry;
			if (registry === void 0) return;
			const agents = liveAgents(state).map((agent) => ({
				id: agent.id,
				...agent.cwd === void 0 ? {} : { cwd: agent.cwd }
			}));
			await scope.rebuild(registry, agents);
			if (state.tornDown || mountTornDown) return;
			applyAll(state);
		} catch (error) {
			log("[cherry-remote] 作用域重算失败（只记录，不抛；判定保持上一代）", error);
		} finally {
			scheduleRechecks(state);
		}
	}
	/**
	* §4 ①'s re-entrancy gate — the ONE entry of a recompute round.
	*
	* The host emits `tools/change` on BOTH sides of `register`/`restrict`, so the
	* plugin's own install and release work necessarily re-enters its own listener.
	* Coalescing is what makes that terminating:
	*
	*  - a round already in flight is never overlapped: the trigger only marks the
	*    round DIRTY, and that round runs one catch-up pass before it ends (§4 ①,
	*    "置脏后补跑，不丢弃") — an event arriving anywhere inside the round,
	*    including its asynchronous interval, is therefore never lost;
	*  - the loop stops at a FIXED POINT: a pass that changes no layer makes no
	*    host call, so it emits nothing and leaves `dirty` false. §4 ③'s bounded
	*    amplification (at most one reinstall per agent per round) rides on the
	*    idempotent short-circuit inside {@link applyForAgent}.
	*
	* This is also §4's ONLY abstention point, and the check is deliberately the
	* same one `refresh` / `onCreated` / `onDisposed` / {@link converge} carry: an
	* event that was already dispatched when the merged disposer ran must reach a
	* dead subsystem — never a recompute, never a layer.
	*/
	function requestRound(state) {
		if (state.tornDown || mountTornDown || !staticCapable) return;
		if (state.running) {
			state.dirty = true;
			return;
		}
		state.running = true;
		runRounds(state);
	}
	/** The gate's body: the round itself, then every catch-up it accumulated. */
	async function runRounds(state) {
		try {
			do {
				state.dirty = false;
				await converge(state);
			} while (state.dirty && !state.tornDown && !mountTornDown);
		} finally {
			state.running = false;
		}
	}
	/**
	* D14's BOUNDED recheck — the other half of the synchronous judgement, and the
	* only trigger of a round that is not an event.
	*
	* The synchronous window ({@link onCreated}, a config save) reads the CACHE and
	* nothing else, so a judgement that is merely LATE — the registry was not
	* ready, a `realpath` call failed, `sessionIds` had not caught up — leaves the
	* agent fail-closed with no way to notice on its own. Every settled round
	* therefore arms at most ONE timer per agent whose judgement is `unresolved`,
	* at `recheckDelaysMs[attempt]`:
	*
	*  - `no-cwd` and `no-match` are terminally invisible (D14): the `cwd` is
	*    detached, deep-frozen creation metadata and a conclusive "no workspace"
	*    cannot become a hit by waiting, so arming a timer for either is exactly
	*    the idle spin this rule exists to forbid;
	*  - the schedule is FINITE — `recheckDelaysMs.length` attempts per agent, and
	*    an attempt is spent by its FIRING — so an unresolvable state costs a
	*    bounded number of rounds and then goes quiet;
	*  - the timer is only a TRIGGER: it calls {@link requestRound} like every
	*    other one, so a recheck landing inside an in-flight round is coalesced
	*    into that round's catch-up pass instead of overlapping it. A direct
	*    `applyAll` here would bypass the gate and could interleave with a round
	*    already in flight.
	*
	* `tornDown` short-circuits the arming AND the firing, so no timer can outlive
	* the generation that armed it (teardown clears the pending ones as well).
	*/
	function scheduleRechecks(state) {
		if (state.tornDown || mountTornDown || !staticCapable) return;
		const agents = liveAgents(state);
		const live = new Set(agents.map((agent) => agent.id));
		for (const [agentId, timer] of [...state.recheckTimers]) {
			if (live.has(agentId)) continue;
			clearTimeout(timer);
			state.recheckTimers.delete(agentId);
		}
		for (const agentId of [...state.recheckSteps.keys()]) if (!live.has(agentId)) state.recheckSteps.delete(agentId);
		for (const agent of agents) {
			if (scope.judgement(agent.id)?.status !== "unresolved") continue;
			if (state.recheckTimers.has(agent.id)) continue;
			const attempt = state.recheckSteps.get(agent.id) ?? 0;
			if (attempt >= recheckDelaysMs.length) continue;
			const timer = setTimeout(() => {
				state.recheckTimers.delete(agent.id);
				state.recheckSteps.set(agent.id, attempt + 1);
				requestRound(state);
			}, recheckDelaysMs[attempt] ?? 0);
			state.recheckTimers.set(agent.id, timer);
		}
	}
	function guardVerdict(execution) {
		if (!names.includes(execution.name)) return void 0;
		const agentId = execution.agent?.id;
		if (agentId === void 0) return void 0;
		const layer = scope.layer(agentId);
		return layer === void 0 ? void 0 : `cherry-remote 作用域限制：${layer.reason}`;
	}
	function refresh() {
		const state = current;
		if (state === void 0 || state.tornDown || mountTornDown || !staticCapable) return void 0;
		const summary = applyAll(state);
		requestRound(state);
		return summary;
	}
	function teardownEffect(state) {
		if (state.tornDown) return;
		state.tornDown = true;
		for (const off of state.offs.splice(0)) try {
			off();
		} catch (error) {
			log("[cherry-remote] 作用域子系统退订失败", error);
		}
		for (const timer of state.recheckTimers.values()) clearTimeout(timer);
		state.recheckTimers.clear();
		state.recheckSteps.clear();
		const releaseRegistrations = state.releaseRegistrations;
		state.releaseRegistrations = void 0;
		try {
			releaseRegistrations?.();
		} catch (error) {
			log("[cherry-remote] 释放 cherry_* 工具注册失败", error);
		}
		for (const [agentId, dispose] of [...state.layers]) {
			if (current === state) scope.clearLayer(agentId);
			disposeQuietly(agentId, dispose);
		}
		state.layers.clear();
		const releaseGuard = state.releaseGuard;
		state.releaseGuard = void 0;
		try {
			releaseGuard?.();
		} catch (error) {
			log("[cherry-remote] 释放 tools.guard 失败", error);
		}
		if (current === state) {
			scope.invalidateDerived();
			current = void 0;
			if (scope.host().state === "ready") scope.setHost({
				state: "pending",
				capable: false,
				reason: `${PENDING_REASON}（注入回调已卸载）`
			});
		}
	}
	function setup(agentCtx) {
		if (mountTornDown) return () => {};
		if (!staticCapable) return () => {};
		scope.setHost({
			state: "ready",
			capable: true,
			reason: READY_REASON
		});
		const state = {
			tornDown: false,
			running: false,
			dirty: false,
			layers: /* @__PURE__ */ new Map(),
			recheckSteps: /* @__PURE__ */ new Map(),
			recheckTimers: /* @__PURE__ */ new Map(),
			agents: agentCtx.agents,
			registry: agentCtx.workspaceRegistry,
			releaseRegistrations: void 0,
			releaseGuard: void 0,
			offs: [],
			teardown: () => {}
		};
		state.teardown = () => teardownEffect(state);
		let releaseRegistrations;
		try {
			releaseRegistrations = deps.registerTools();
		} catch (error) {
			state.tornDown = true;
			scope.setHost({
				state: "unsupported",
				capable: false,
				reason: `cherry_* 工具注册失败：${describeError(error)}`
			});
			log("[cherry-remote] cherry_* 工具注册失败；作用域子系统未启用，未安装任何 restriction", error);
			return state.teardown;
		}
		state.releaseRegistrations = releaseRegistrations;
		current = state;
		const rootTools = root?.tools;
		if (typeof rootTools?.guard === "function") try {
			state.releaseGuard = rootTools.guard((execution) => guardVerdict(execution));
		} catch (error) {
			degradeToVisibilityOnly(`宿主 tools.guard 安装被拒绝：${describeError(error)}`, error);
		}
		else degradeToVisibilityOnly("宿主缺 tools.guard：执行层兜底不可用，降级为“仅可见性”（restrict 仍在装配层移除这 14 个工具，不是渲染层假过滤）");
		const on = agentCtx.on;
		if (typeof on === "function") {
			subscribe(state, on, "agent/created", (payload) => {
				onCreated(state, payload);
			});
			subscribe(state, on, "agent/disposed", (payload) => {
				onDisposed(state, payload);
			});
			subscribe(state, on, "tools/change", () => {
				requestRound(state);
			});
		}
		refresh();
		return state.teardown;
	}
	/**
	* B17's single reporting site: the guard being ABSENT and the host REFUSING it
	* are the same degradation — "仅可见性". It is reported through the existing
	* warn carrier and recorded in §6.1's `degraded` set, never silent, and it is
	* never a reason to refuse registration.
	*/
	function degradeToVisibilityOnly(reason, error) {
		scope.noteDegraded({
			source: "visibility-only",
			reason
		});
		log(`[cherry-remote] ${reason}`, error);
	}
	/**
	* One subscription, contained (R16): a host that refuses `on(…)` must not take
	* the round down with it — the failure is reported and the round continues with
	* whatever subscriptions succeeded. `DegradedSource` is a fixed five with no
	* member for a refused subscription, so the honest carrier is the existing warn
	* channel — the same way §6.1 handles a parse failure (B9).
	*/
	function subscribe(state, on, event, handle) {
		try {
			state.offs.push(on(event, handle));
		} catch (error) {
			log(`[cherry-remote] 订阅 ${event} 失败；该事件的重算触发器缺失，本轮继续（其余订阅与已装层不受影响）`, error);
		}
	}
	/** `agent/created`: synchronous, cache-only, never throws (host `@mode serial`). */
	function onCreated(state, payload) {
		if (state.tornDown || mountTornDown) return;
		const agent = projectAgent(payload?.agent);
		if (agent === void 0) return;
		try {
			applyForAgent(state, agent);
		} catch (error) {
			log(`[cherry-remote] agent ${agent.id} 的首次装配失败（不阻塞建会话）`, error);
		}
		requestRound(state);
	}
	/**
	* `agent/disposed`: releases exactly that agent's layer and its record.
	*
	* The agent's pending recheck goes with it: a session that no longer exists
	* owes no later round, so an armed timer here would be one wasted recompute at
	* best — the smaller version of the leak teardown closes for the whole
	* generation.
	*/
	function onDisposed(state, payload) {
		if (state.tornDown || mountTornDown) return;
		const agent = projectAgent(payload?.agent);
		if (agent === void 0) return;
		try {
			const timer = state.recheckTimers.get(agent.id);
			if (timer !== void 0) {
				clearTimeout(timer);
				state.recheckTimers.delete(agent.id);
			}
			state.recheckSteps.delete(agent.id);
			const dispose = state.layers.get(agent.id);
			scope.clearLayer(agent.id);
			state.layers.delete(agent.id);
			if (dispose !== void 0) disposeQuietly(agent.id, dispose);
		} catch (error) {
			log(`[cherry-remote] 释放 agent ${agent.id} 的 restriction 失败（不阻塞处置）`, error);
		}
	}
	return {
		mount(ctx) {
			root = ctx;
			mountTornDown = false;
			const probed = probe(ctx.tools);
			staticCapable = probed.capable;
			if (!staticCapable) {
				scope.setHost({
					state: "unsupported",
					capable: false,
					reason: probed.reason
				});
				log(`[cherry-remote] 作用域子系统未启用：${probed.reason}`);
			} else scope.setHost({
				state: "pending",
				capable: false,
				reason: PENDING_REASON
			});
			try {
				ctx.inject?.(INJECT_KEYS, (agentCtx) => {
					agentCtx.effect?.(() => setup(agentCtx), EFFECT_LABEL);
				});
			} catch (error) {
				log("[cherry-remote] agents / workspaceRegistry 注入不可用；作用域子系统保持 pending", error);
				scope.setHost({
					state: "pending",
					capable: false,
					reason: PENDING_REASON
				});
			}
			return () => {
				mountTornDown = true;
				const teardown = current?.teardown;
				teardown?.();
			};
		},
		refresh,
		state() {
			return scope.host();
		}
	};
}
//#endregion
//#region src/httpApi.ts
/**
* The plugin's same-origin HTTP face (spec §3.7): device management REST plus
* an SSE stream, mounted on the HOST web server's `/cherry-remote/api` prefix.
* There is no dedicated port, no bootstrap file and no credential channel — the
* settings page and this surface are same-origin by construction.
*
* Two disciplines run through every route:
*
*  - **The trust fence is per-route and unconditional** (ruling 1): the host
*    owns the listen address, but DNS rebinding and cross-site requests are
*    the plugin's problem, so `isTrustedWebRequest` guards each handler before
*    any work happens.
*  - **No route throws.** Every failure leaves as a structured JSON body, and
*    the pairing verdicts stay distinguishable (`invalid-payload` is the
*    client's 400; `unreachable`/`rejected`/`expired` are the peer's 502).
*    A QUARANTINED archive gets its own shape rather than the generic
*    `invalid-device` 400 — see {@link writeQuarantineRefusal}.
*
* Registration is lazy and headless-safe: `registerHttpApi` dynamically
* injects `webServer`/`webRuntime` and degrades to a warning when the
* deployment has no web half.
*/
/** The plugin's route prefix: an absolute pathname with no trailing slash. */
const HTTP_API_PREFIX = "/cherry-remote/api";
/** SSE heartbeat cadence; keeps proxies from reaping an idle stream. */
const HEARTBEAT_MS = 3e4;
function header(headers, name) {
	const value = headers[name];
	if (Array.isArray(value)) return value[0];
	return value;
}
/**
* Whether a `URL.hostname`-shaped authority names the local machine.
*
* The input is the WHATWG host SERIALIZATION, which KEEPS the brackets on an
* IPv6 literal: `new URL('http://[::1]:23023').hostname` is `'[::1]'` in Node
* and in the browser alike, so the bracketed spellings below are the real ones.
* (Review E2-2 claimed the brackets are stripped and the `'[::1]'` literal was
* therefore dead; that is measurably false — the fence already admitted
* `[::1]:23023` before this change. Both spellings are accepted so a caller
* passing a raw `Host` header value gets the same verdict either way.)
*
* The gap that WAS real is the IPv4-MAPPED loopback family: a dual-stack
* listener reached over IPv6 is addressed as `::ffff:127.0.0.1`, and the
* WHATWG serializer rewrites that to the hex form `[::ffff:7f00:1]`. Those are
* loopback by any honest reading and now qualify. Only the mapped 127/8 range
* does — `[::ffff:8.8.8.8]` is NOT loopback, so this is not a blanket "any v6
* with a ffff: prefix" admission.
*/
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (bare === "::1") return true;
	if (bare.startsWith("::ffff:")) {
		const mapped = bare.slice(7);
		const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
		if (hex !== null) return Number.parseInt(hex[1], 16) >>> 8 === 127;
		return isLoopbackHostname(mapped);
	}
	const parts = bare.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Canonical authority of a `trustedHosts` entry or a `Host` header. */
function parseAuthority(authority) {
	if (typeof authority !== "string" || authority.length === 0) return void 0;
	try {
		const url = new URL(`http://${authority}`);
		return url.hostname === "" ? void 0 : {
			hostname: url.hostname,
			host: url.host,
			bare: url.port === ""
		};
	} catch {
		return;
	}
}
/**
* Whether the request authority is a deployment-declared trusted host.
*
* A port-less entry matches the hostname on any port (the shape the CLI derives
* for IP-literal LAN serving, where the bound port may be OS-assigned); an
* entry with an explicit port matches that exact authority.
*/
function isTrustedAuthority(hostUrl, trustedHosts) {
	for (const entry of trustedHosts) {
		const parsed = parseAuthority(entry);
		if (parsed === void 0) continue;
		if (parsed.bare ? parsed.hostname === hostUrl.hostname : parsed.host === hostUrl.host) return true;
	}
	return false;
}
/**
* The browser-trust fence, applied on EVERY route before any work.
*
* Two confused-deputy paths are closed: DNS rebinding (a name the attacker
* controls resolving to this server) and cross-site requests fired from a
* malicious page. `Host` is judged first and unconditionally — over plain HTTP
* a browser attaches neither `Origin` nor Fetch Metadata to reads, so an
* unmarked request may still be a rebound browser read, and Host is the one
* header rebinding cannot forge.
*
* The four branches, in order:
*  1. non-loopback / undeclared Host → reject;
*  2. `sec-fetch-site: cross-site` → reject;
*  3. attached `Origin` not same-origin with Host → reject;
*  4. **absent `Origin` → admit** — that is a non-browser client (curl, a
*     same-host script), not a browser doing a cross-site request.
*/
function isTrustedWebRequest(request, trustedHosts = []) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** Structured rejection: 403 for the fence, `{error}` for everything else. */
function writeError(res, status, error, message) {
	writeJson(res, status, message === void 0 ? { error } : {
		error,
		message
	});
}
/**
* The quarantine refusal, as the browser and the operator see it.
*
* A damaged `devices.json` is not the request's fault and it is not something
* the browser can fix: the archive is READ-ONLY until a human moves the bad
* file aside. So the answer is a 503 with the two paths an operator actually
* needs — the archive, and the `<file>.corrupt` copy the plugin preserved —
* plus the recovery step in words. That is the whole point of giving this its
* own shape rather than letting it land in the generic `invalid-device` 400,
* which reads as "you sent something wrong" and is the opposite of the truth.
*
* Returns true when the error was a quarantine (and a response was written).
*/
function writeQuarantineRefusal(res, route, error) {
	if (!(error instanceof QuarantinedArchiveError)) return false;
	try {
		route.deps.onArchiveQuarantined?.(error);
	} catch (reportError) {
		console.warn("[cherry-remote] reporting the quarantined archive failed", reportError);
	}
	writeJson(res, 503, {
		error: "archive-quarantined",
		file: error.file,
		corrupt: error.corruptPath ?? `${error.file}.corrupt`,
		recovery: QUARANTINE_RECOVERY,
		message: error.message
	});
	return true;
}
const MAX_BODY_BYTES = 1048576;
/** Reads and parses a JSON request body; throws a body-level error on refusal. */
async function readJsonBody(req) {
	const chunks = [];
	let length = 0;
	if (req[Symbol.asyncIterator] !== void 0) for await (const chunk of req) {
		length += chunk.length;
		if (length > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
		chunks.push(Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/** Splits the pathname under the API prefix; undefined = not this route's. */
function matchPath(req) {
	let pathname;
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		return;
	}
	if (pathname === "/cherry-remote/api") return { segments: [] };
	if (!pathname.startsWith(`/cherry-remote/api/`)) return void 0;
	return { segments: pathname.slice(19).split("/").filter((segment) => segment !== "") };
}
function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return;
	}
}
/** Field caps mirroring pairing's payload rules (spec §3.3 step 1). */
const HOST_MAX = 256;
const DISPLAY_NAME_MAX = 64;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** A validation refusal, mapped to 400 by the route. */
var PatchError = class extends Error {};
/**
* Normalizes one candidate host the same way pairing does: the archive stores
* bare hosts, and a bracketed IPv6 literal is unwrapped (a bracketed non-literal
* is refused rather than silently rewritten).
*/
function normalizeHost(raw) {
	if (raw.length === 0) throw new PatchError("hosts must not contain an empty entry");
	if (raw.length > HOST_MAX) throw new PatchError(`hosts entry exceeds ${HOST_MAX} characters`);
	if (!(raw.startsWith("[") && raw.endsWith("]"))) return raw;
	try {
		new URL(`http://${raw}/`);
	} catch {
		throw new PatchError(`hosts entry "${raw}" is not a valid IPv6 literal`);
	}
	return raw.slice(1, -1);
}
/**
* Validates a PATCH body. `hosts` is WHOLE-REPLACE by contract, and `port` is
* shared by every host (spec §3.2) — there is no per-host port and no merge
* semantics to get wrong.
*/
function parsePatch(body) {
	const patch = {};
	const displayName = body["displayName"];
	if (displayName !== void 0) {
		if (typeof displayName !== "string") throw new PatchError("displayName must be a string");
		if (displayName.length === 0) throw new PatchError("displayName must not be empty");
		if (displayName.length > DISPLAY_NAME_MAX) throw new PatchError(`displayName exceeds ${DISPLAY_NAME_MAX} characters`);
		if (LONE_SURROGATE_RE.test(displayName)) throw new PatchError("displayName is not valid unicode text");
		patch.displayName = displayName;
	}
	const enabled = body["enabled"];
	if (enabled !== void 0) {
		if (typeof enabled !== "boolean") throw new PatchError("enabled must be a boolean");
		patch.enabled = enabled;
	}
	const hosts = body["hosts"];
	if (hosts !== void 0) {
		if (!Array.isArray(hosts) || hosts.length === 0) throw new PatchError("hosts must be a non-empty array");
		patch.hosts = hosts.map((entry) => {
			if (typeof entry !== "string") throw new PatchError("hosts entries must be strings");
			return normalizeHost(entry);
		});
	}
	const port = body["port"];
	if (port !== void 0) {
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new PatchError("port must be an integer in 1..65535");
		patch.port = port;
	}
	return patch;
}
/**
* The same-origin event stream: device states plus pairing progress.
*
* Per the shared contract, a NEW subscriber is pushed one `device-state` frame
* per known device before anything else, so the client's first render already
* has initial state instead of waiting for a change. Disconnects remove the
* client and stop the heartbeat once the last one leaves (a leaked interval
* would keep the process alive; Review Focus #5 covers the dispose path too).
*/
var SseHub = class {
	deps;
	#clients = /* @__PURE__ */ new Set();
	#detachers = [];
	#timer;
	#disposed = false;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* Starts observing the assembly channels. Called once, after registration.
	*
	* Registering is not enough: the listener sets live on the ASSEMBLY, which
	* outlives any one hub, so each detacher is kept and run in {@link dispose}.
	* Without that, a re-apply (a new hub over the same assembly) accumulates one
	* stale pair per cycle, and every later event fans out to hubs that are
	* already closed.
	*/
	start() {
		const detachDevice = this.deps.onDeviceState((event) => this.publish("device-state", event));
		const detachPairing = this.deps.onPairingProgress((event) => this.publish("pairing-progress", event));
		if (typeof detachDevice === "function") this.#detachers.push(detachDevice);
		if (typeof detachPairing === "function") this.#detachers.push(detachPairing);
	}
	subscribe(req, res) {
		const snapshot = this.#snapshot();
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no"
		});
		const client = {
			req,
			res
		};
		this.#clients.add(client);
		const close = () => this.#remove(client);
		req.on?.("close", close);
		res.on?.("close", close);
		for (const device of snapshot) this.#write(client, "device-state", {
			deviceId: device.deviceId,
			state: device.state
		});
		this.#ensureHeartbeat();
	}
	publish(event, payload) {
		for (const client of [...this.#clients]) this.#write(client, event, payload);
	}
	/** Live device projections, sourced from the record + its connection state. */
	#snapshot() {
		return this.deps.store.list().map((device) => ({
			deviceId: device.deviceId,
			state: projectState(device, this.deps.connect)
		}));
	}
	#write(client, event, payload) {
		try {
			client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch {
			this.#remove(client);
		}
	}
	#ensureHeartbeat() {
		if (this.#timer !== void 0 || this.#clients.size === 0) return;
		this.#timer = setInterval(() => {
			for (const client of [...this.#clients]) try {
				client.res.write(`: ping ${Date.now()}\n\n`);
			} catch {
				this.#remove(client);
			}
		}, HEARTBEAT_MS);
		this.#timer.unref?.();
	}
	#remove(client) {
		if (!this.#clients.delete(client)) return;
		if (this.#clients.size === 0 && this.#timer !== void 0) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
	}
	/** Ends every live stream, detaches the assembly listeners, stops the heartbeat. */
	dispose() {
		this.#disposed = true;
		for (const detach of this.#detachers.splice(0)) try {
			detach();
		} catch (error) {
			console.warn("[cherry-remote] sse listener detach failed", error);
		}
		if (this.#timer !== void 0) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
		for (const client of [...this.#clients]) try {
			client.res.end();
		} catch {}
		this.#clients.clear();
	}
	get disposed() {
		return this.#disposed;
	}
};
/**
* The projected state of one device (ruling 7): a device the user disabled is
* `disabled` regardless of what its connection last reported, and a device
* whose connection has not been built yet is `offline` — the same honest
* "unknown" the connection starts from.
*/
function projectState(device, connect) {
	if (!device.enabled) return "disabled";
	try {
		return connect(device.deviceId).state;
	} catch {
		return "offline";
	}
}
/** Maps a pairing failure to the HTTP verdict; invalid payload ≠ peer failure. */
function pairingVerdict(error) {
	if (error instanceof PairingError) {
		if (error.kind === "invalid-payload") return {
			status: 400,
			error: error.kind,
			message: error.message
		};
		return {
			status: 502,
			error: error.kind,
			message: error.message
		};
	}
	return {
		status: 502,
		error: "pairing-failed",
		message: error instanceof Error ? error.message : String(error)
	};
}
/**
* Registers the plugin's same-origin HTTP face on the host's web server.
*
* The web services arrive by dynamic injection (the `dsh-mcp-connector`
* pattern): a headless deployment simply has no `webServer`, so the call warns
* and skips registration instead of failing the plugin — the tool face stays
* usable. The returned disposer unregisters the route seat (the host throws on
* a duplicate `(kind, path)`, so a second `apply` would otherwise fail).
*
* The route handler is a SINGLE prefix registration that dispatches the five
* endpoints internally: one disposer, one fence site, no route-table churn.
*/
function registerHttpApi(ctx, deps) {
	if (typeof ctx.inject !== "function") {
		console.warn("[cherry-remote] webServer unavailable (no dynamic injection); http api not mounted");
		return () => {};
	}
	let disposeRoutes;
	try {
		ctx.inject(["webServer", "webRuntime"], (wctx) => {
			const webServer = wctx.webServer;
			if (webServer === void 0) {
				console.warn("[cherry-remote] webServer unavailable; http api not mounted");
				return;
			}
			disposeRoutes = mountRoutes(webServer, wctx.webRuntime?.trustedHosts ?? [], deps);
			console.info(`[cherry-remote] http api mounted at ${HTTP_API_PREFIX}`);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[cherry-remote] http api not mounted (webServer unavailable): ${message}`);
	}
	return () => {
		disposeRoutes?.();
		disposeRoutes = void 0;
	};
}
/** Owns one route seat and its SSE hub; returns the teardown for both. */
function mountRoutes(webServer, trustedHosts, deps) {
	const hub = new SseHub(deps);
	const fence = (req) => isTrustedWebRequest(req, trustedHosts);
	const unregister = webServer.register({
		kind: "prefix",
		path: HTTP_API_PREFIX,
		handler: (req, res) => handleRequest(req, res, {
			deps,
			hub,
			fence
		})
	});
	hub.start();
	return () => {
		unregister?.();
		hub.dispose();
	};
}
/**
* The single dispatcher behind the prefix. It owns the full response lifecycle
* for every outcome, including the fence verdict and every error path — a
* handler that throws here would leave the browser waiting on a socket nobody
* will ever answer.
*/
async function handleRequest(req, res, route) {
	try {
		if (!route.fence(req)) {
			writeError(res, 403, "forbidden", "request is not from a trusted same-origin browser");
			return;
		}
		const match = matchPath(req);
		if (match === void 0) {
			writeError(res, 404, "not-found", "unknown route");
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		const [first, second] = match.segments;
		if (match.segments.length === 0) {
			writeError(res, 404, "not-found", `unknown route (try ${HTTP_API_PREFIX}/devices)`);
			return;
		}
		if (first === "devices" && second === void 0) {
			if (method === "GET") return listDevices(res, route);
			writeError(res, 405, "method-not-allowed", "GET only");
			return;
		}
		if (first === "devices" && match.segments.length === 2 && second !== void 0) {
			const deviceId = decodeSegment(second);
			if (deviceId === void 0) {
				writeError(res, 400, "invalid-request", "device id is not valid URL encoding");
				return;
			}
			if (method === "DELETE") return await deleteDevice(res, route, deviceId);
			if (method === "PATCH") return patchDevice(req, res, route, deviceId);
			writeError(res, 405, "method-not-allowed", "DELETE or PATCH only");
			return;
		}
		if (first === "pair" && match.segments.length === 1) {
			if (method !== "POST") {
				writeError(res, 405, "method-not-allowed", "POST only");
				return;
			}
			return startPairing(req, res, route);
		}
		if (first === "events" && match.segments.length === 1) {
			if (method !== "GET") {
				writeError(res, 405, "method-not-allowed", "GET only");
				return;
			}
			return openEvents(req, res, route);
		}
		if (first === "diagnostics" && match.segments.length === 1) {
			if (method !== "GET") {
				writeError(res, 405, "method-not-allowed", "GET only");
				return;
			}
			return writeJson(res, 200, diagnosticsReport(route));
		}
		if (first === "scope" && match.segments.length === 1) {
			if (method === "GET") return scopeSnapshot(res, route);
			if (method === "PUT") return await saveScopeDocument(req, res, route);
			writeError(res, 405, "method-not-allowed", "GET/PUT only");
			return;
		}
		writeError(res, 404, "not-found", "unknown route");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[cherry-remote] http api request failed: ${message}`);
		try {
			writeError(res, 500, "internal-error", message);
		} catch {}
	}
}
function listDevices(res, route) {
	writeJson(res, 200, route.deps.store.list().map((device) => ({
		deviceId: device.deviceId,
		displayName: device.displayName,
		state: projectState(device, route.deps.connect),
		enabled: device.enabled,
		hosts: [...device.hosts],
		port: device.port
	})));
}
/**
* The `GET /diagnostics` body (spec §5).
*
* The aggregator in `src/diagnostics.ts` owns the redaction whitelist; this
* function only supplies it with the live pool surfaces, as a state projection
* (not the connection object) so nothing but a state string and four numbers
* can escape into the report — a caller cannot accidentally serialize a
* connection holding a live token.
*
* THE SEAM HANDED TO THE AGGREGATOR NEVER BUILDS A CONNECTION. The aggregator's
* `connect` is named for the pool's resolver, but here it resolves an EXISTING
* entry only (see {@link deviceProjection}): a GET must be a read, and a
* report that dials is both a surprise socket and a fabricated `limits`.
*
* The six contract differences ride along so an operator reads the fake-vs-real
* caveats in the same place they read the health of the deployment.
*/
function diagnosticsReport(route) {
	const deps = route.deps;
	const config = safely(() => deps.diagnosticsConfig?.(), void 0);
	return {
		...buildDiagnostics({
			store: deps.store,
			connect: (deviceId) => deviceProjection(deps, deviceId),
			stats: () => safely(() => deps.diagnosticsStats?.(), {}),
			sessions: () => safely(() => deps.diagnosticsSessions?.(), []),
			recentErrors: () => safely(() => deps.diagnosticsErrors?.(), []),
			scope: () => readScopeSegment(deps.scope)
		}),
		...config === void 0 ? {} : { config },
		contractDifferences: CONTRACT_DIFFERENCES.map((entry) => ({
			id: entry.id,
			title: entry.title
		}))
	};
}
/**
* `GET /cherry-remote/api/scope`: the whole scope state in ONE body.
*
* The workspace list is read from the registry by the PLUGIN and projected DOWN
* (id/title/path only) because the browser cannot reach the registry at all;
* `sessionIds` is judgement input, not page state, and stays behind.
*
* `staleWorkspaceIds` and `pathUnmatched` are two SEPARATE channels beside
* `host`, on purpose (§6.1): "an id the registry no longer has" and "this
* session's cwd belongs to no registered workspace" are different answers, and
* neither may be derived from the other. `degraded` is an ARRAY inside `host` —
* same source deduplicated (latest reason), different sources coexisting — and
* an empty array is the honest "no degradation".
*
* `host` and `pathUnmatched` come out of {@link readScopeSegment} — the very
* call the diagnostics report reads its `scope` segment through, so the two
* faces serve ONE read of ONE scope state and cannot drift apart (Task 9 ②).
*/
function scopeSnapshot(res, route) {
	const scope = route.deps.scope;
	const read = readScopeSegment(scope);
	writeJson(res, 200, {
		scope: scopeProjection(scope.doc()),
		workspaces: scope.workspaces().map((workspace) => ({
			id: workspace.id,
			title: workspace.title,
			path: workspace.path
		})),
		staleWorkspaceIds: [...scope.staleWorkspaceIds()],
		pathUnmatched: read.pathUnmatched,
		host: read.host
	});
}
/**
* The three fields the write side accepts back, as every response carries them.
*
* Projected field by field rather than spread: `version`/`updatedAt` are the
* persistence layer's business, and the settings page's read-modify-write cycle
* needs exactly the document it can PUT back beside a base `revision`.
*/
function scopeProjection(doc) {
	return {
		mode: doc.mode,
		workspaceIds: [...doc.workspaceIds],
		revision: doc.revision
	};
}
/**
* `PUT /cherry-remote/api/scope`: validate and commit, then refresh.
*
* The shape exists for the ONE await-free critical section at its end. `save()`
* validates the base revision, prunes, bumps the revision by exactly one, writes
* the file and swaps the in-memory authority — all synchronously — and
* `refreshScope()` is called in the very next statement. An `await` anywhere
* between the two would let two concurrent saves both pass the revision check,
* after which the later write silently overwrites the earlier one.
*
* The refresh is NOT awaited and its summary is NOT published (R24): that
* summary describes the synchronous pass the call itself ran, while convergence
* — the recompute round it triggers plus the catch-up pass the coalescing gate
* owes it — rides behind the response. What the caller gets back is the
* authoritative new state: the normalized document (with the pruned ids gone)
* and the new revision its next write must base itself on.
*/
async function saveScopeDocument(req, res, route) {
	let body;
	try {
		body = await readJsonBody(req);
	} catch (error) {
		writeError(res, 400, "invalid-request", error instanceof Error ? error.message : String(error));
		return;
	}
	const result = route.deps.scope.save(body, body.expectedRevision);
	if (!result.ok) {
		writeError(res, result.status, result.error, result.message);
		return;
	}
	route.deps.refreshScope();
	writeJson(res, 200, {
		scope: scopeProjection(result.doc),
		pruned: [...result.pruned]
	});
}
/**
* One device's diagnostics projection: the live state plus, when a connection
* actually EXISTS, the limits the peer's hello negotiated.
*
* A DIAGNOSTICS ENDPOINT MUST NOT HAVE SIDE EFFECTS, and `connect` is a
* side-effecting seam: it RESOLVES *and* CREATES on miss, so probing it here
* would auto-dial every offline device in the archive — an operator asking for a
* health report would be the thing that opens sockets — and would then publish
* the freshly built connection's conservative client FALLBACKS as if the peer
* had negotiated them.
*
* So `limits` is read through `detach` (resolve-EXISTING-only) and only through
* it. Consequences, both intended:
*  - a device with no pooled connection reports its state from the store/enabled
*    projection and carries NO `limits` field at all (absent means "not
*    reported", which is the truth — nothing has been negotiated);
*  - `detach` is optional on the deps contract, so a rig that supplies only
*    `connect` gets the no-limits shape rather than a fabricated one. Falling
*    back to `connect` would reinstate the dial.
*/
function deviceProjection(deps, deviceId) {
	const record = deviceById(deps, deviceId);
	const existing = safely(() => deps.detach?.(deviceId));
	const state = existing === void 0 ? projectState(record, noDial) : safeState(existing, record);
	const limits = existing?.limits;
	return limits === void 0 ? { state } : {
		state,
		limits
	};
}
/** A resolver that never builds anything: the honest "no connection" report. */
function noDial(deviceId) {
	throw new Error(`diagnostics does not build a connection for ${deviceId}`);
}
/** One already-existing connection's state, or the record's projection. */
function safeState(connection, record) {
	if (!record.enabled) return "disabled";
	try {
		return connection.state;
	} catch {
		return "offline";
	}
}
/** Resolves one record for the state projection, or a disabled stand-in. */
function deviceById(deps, deviceId) {
	const found = deps.store.list().find((device) => device.deviceId === deviceId);
	if (found !== void 0) return found;
	return {
		schemaVersion: 2,
		deviceId,
		displayName: "",
		hosts: [],
		port: 0,
		desktopIdentity: "",
		grants: [],
		enabled: false
	};
}
function safely(read, fallback) {
	try {
		return read() ?? fallback;
	} catch {
		return fallback;
	}
}
async function deleteDevice(res, route, deviceId) {
	if (!route.deps.store.list().some((device) => device.deviceId === deviceId)) {
		writeError(res, 404, "not-found", `no device ${deviceId}`);
		return;
	}
	try {
		await route.deps.evict?.(deviceId);
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} teardown failed before removal`, error);
	}
	try {
		route.deps.store.remove(deviceId);
	} catch (error) {
		if (writeQuarantineRefusal(res, route, error)) return;
		console.warn(`[cherry-remote] device ${deviceId} could not be removed`, error);
		writeError(res, 500, "internal-error", error instanceof Error ? error.message : String(error));
		return;
	}
	res.writeHead(204, { "cache-control": "no-store" });
	res.end();
}
async function patchDevice(req, res, route, deviceId) {
	const existing = route.deps.store.list().find((device) => device.deviceId === deviceId);
	if (existing === void 0) {
		writeError(res, 404, "not-found", `no device ${deviceId}`);
		return;
	}
	let patch;
	try {
		patch = parsePatch(await readJsonBody(req));
	} catch (error) {
		writeError(res, 400, "invalid-request", error instanceof Error ? error.message : String(error));
		return;
	}
	const previousEnabled = existing.enabled;
	const previousHosts = existing.hosts;
	const previousPort = existing.port;
	const next = {
		...existing,
		...patch.displayName === void 0 ? {} : { displayName: patch.displayName },
		...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
		...patch.hosts === void 0 ? {} : { hosts: patch.hosts },
		...patch.port === void 0 ? {} : { port: patch.port }
	};
	try {
		route.deps.store.upsert(next);
	} catch (error) {
		if (writeQuarantineRefusal(res, route, error)) return;
		writeError(res, 400, "invalid-device", error instanceof Error ? error.message : String(error));
		return;
	}
	const addressChanged = patch.hosts !== void 0 && !sameHosts(patch.hosts, previousHosts) || patch.port !== void 0 && patch.port !== previousPort;
	const enabledChanged = patch.enabled !== void 0 && patch.enabled !== previousEnabled;
	if (addressChanged) evict(route, deviceId);
	if (enabledChanged) hibernate(route, deviceId);
	if (enabledChanged && patch.enabled) try {
		track(route.deps.connect(deviceId).connect(), warnConnect(deviceId));
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} reconnect failed`, error);
	}
	const state = projectState(next, route.deps.connect);
	if (patch.enabled !== void 0 && patch.enabled !== previousEnabled) route.hub.publish("device-state", {
		deviceId,
		state
	});
	writeJson(res, 200, {
		deviceId: next.deviceId,
		displayName: next.displayName,
		state,
		enabled: next.enabled,
		hosts: [...next.hosts],
		port: next.port
	});
}
function warnConnect(deviceId) {
	return (error) => {
		console.warn(`[cherry-remote] device ${deviceId} lifecycle change failed`, error);
	};
}
/** Order-sensitive host comparison: `hosts` is an ordered candidate list. */
function sameHosts(a, b) {
	return a.length === b.length && a.every((host, index) => host === b[index]);
}
/** Drops the pooled connection, closing any live socket first. */
function evict(route, deviceId) {
	try {
		route.deps.evict?.(deviceId);
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} eviction failed`, error);
	}
}
/**
* Puts one device to sleep: drop its pooled connection and close the live
* socket, resolving an EXISTING instance only.
*
* The `detach` seam (never `connect`) is what makes this safe — `connect`
* creates on miss, so a disable would otherwise leave a fresh connection
* holding `enabled:false` in the pool.
*/
function hibernate(route, deviceId) {
	evict(route, deviceId);
	try {
		track(route.deps.detach?.(deviceId)?.close(), warnConnect(deviceId));
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} disconnect failed`, error);
	}
}
/** Attaches a rejection handler to a lifecycle promise, when one was returned. */
function track(result, onRejected) {
	if (result !== null && typeof result?.then === "function") result.then(void 0, onRejected);
}
/**
* Starts a pairing run and returns IMMEDIATELY (ruling 2).
*
* The wire contract is 202 + `{claimId}`, with the 6-digit verification code
* and the terminal state delivered as `pairing-progress` frames — a browser
* fetch must not sit open for the whole 120s invitation window, and the card
* the user is comparing the code against is already rendered.
*
* The pairing session is scoped to THIS request's callbacks, so a second
* concurrent pairing (a second tab) cannot INVOKE the first run's callbacks.
* That alone is not enough for the browser side, though: the SSE stream is
* shared, so every frame this run publishes also carries `claimId` — the same
* handle the 202 returned — and the wizard filters by its own. Callback
* scoping keeps the runs apart on the server; the id keeps them apart on the
* client.
*/
async function startPairing(req, res, route) {
	let body;
	try {
		body = await readJsonBody(req);
	} catch (error) {
		writeError(res, 400, "invalid-request", error instanceof Error ? error.message : String(error));
		return;
	}
	const payload = body["payload"];
	if (typeof payload !== "string" || payload.length === 0) {
		writeError(res, 400, "invalid-request", "payload must be a non-empty string");
		return;
	}
	const name = body["name"];
	if (name !== void 0 && typeof name !== "string") {
		writeError(res, 400, "invalid-request", "name must be a string");
		return;
	}
	if (route.hub.disposed) {
		writeError(res, 503, "unavailable", "the plugin http api is shutting down");
		return;
	}
	const claimId = randomUUID();
	const publish = (stage, detail) => {
		route.hub.publish("pairing-progress", {
			stage,
			...detail === void 0 ? {} : { detail },
			claimId
		});
	};
	(async () => {
		try {
			await route.deps.pair({
				identity: route.deps.identity(),
				payload,
				store: route.deps.store,
				...name === void 0 ? {} : { name },
				onStatus: (stage) => publish(stage),
				onVerificationCode: (code) => publish("verification-code", code)
			});
			publish("approved");
		} catch (error) {
			if (error instanceof QuarantinedArchiveError) {
				console.warn(`[cherry-remote] pairing ${claimId} could not persist: the archive is quarantined`);
				try {
					route.deps.onArchiveQuarantined?.(error);
				} catch (reportError) {
					console.warn("[cherry-remote] reporting the quarantined archive failed", reportError);
				}
				publish("archive-quarantined", `${QUARANTINE_RECOVERY} (archive: ${error.file}; preserved as ${error.corruptPath ?? `${error.file}.corrupt`})`);
				return;
			}
			const verdict = pairingVerdict(error);
			console.warn(`[cherry-remote] pairing ${claimId} failed (${verdict.error}): ${verdict.message}`);
			publish(verdict.error, verdict.message);
		}
	})();
	writeJson(res, 202, { claimId });
}
function openEvents(req, res, route) {
	if (route.hub.disposed) {
		writeError(res, 503, "unavailable", "the plugin http api is shutting down");
		return;
	}
	route.hub.subscribe(req, res);
}
//#endregion
//#region src/index.ts
const name = "cherry-remote";
const inject = ["tools"];
/** Applies the documented fallbacks to the plugin config's numeric keys. */
function resolveBridgeConfig(config = {}) {
	return {
		rateBudgetPerSecond: positive("rateBudgetPerSecond", config.rateBudgetPerSecond, 32),
		perSessionCacheBytes: positive("perSessionCacheBytes", config.perSessionCacheBytes, DEFAULT_PER_SESSION_CACHE_BYTES)
	};
}
/**
* A configured positive number, or the fallback when absent/unusable.
*
* An ABSENT key is the documented default and says nothing; a key that is
* PRESENT but unusable (`null`, `0`, `-1`, `NaN`, a string from a hand-edited
* config) is a deployment mistake that silently changes behaviour, so it is
* warned about by name rather than swallowed — the caller gets the fallback they
* would have got anyway, plus the reason it was not their value.
*
* `null` is warned about rather than treated as absent, and that is a
* correction, not pedantry: a YAML key written as `rateBudgetPerSecond:` parses
* to `null`, and the operator who wrote that line believes they configured
* something. Only `undefined` — the key genuinely not being there — is silent.
*/
function positive(key, value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		console.warn(`[cherry-remote] config "${key}" must be a positive number (got ${JSON.stringify(value)}); falling back to ${fallback}`);
		return fallback;
	}
	return value;
}
/** The data directory convention every DSH plugin follows. */
function resolveDataDir(config = {}, env = process.env) {
	if (config.dataDir !== void 0 && config.dataDir !== "") return config.dataDir;
	const home = env["DSH_HOME"];
	if (home !== void 0 && home !== "") return join(home, "cherry-remote");
	return join(homedir(), ".dsh", "cherry-remote");
}
/** How many recent errors the diagnostics ring holds. */
const RECENT_ERROR_LIMIT = 20;
/**
* Records one error summary for the diagnostics endpoint.
*
* TWO bounds, both real:
*
*  - the ring keeps at most {@link RECENT_ERROR_LIMIT} entries, and
*  - the `message` is truncated to {@link ERROR_MESSAGE_MAX} characters here
*    too, so an over-long string never enters memory in the first place. The
*    HTTP boundary applies the same cap again (`sanitizeDiagnostics`), which is
*    the one that actually protects the endpoint — this one is cheap
*    defense in depth.
*
* PRODUCER DISCIPLINE (not enforced by types): pass pre-redacted static context
* — a device id, a state name, a protocol reason. NEVER a peer-echoed payload:
* `message` is the only free-text field that reaches the report, and the
* truncation bounds its LENGTH, not its sensitivity.
*/
function noteError(entry) {
	state.recentErrors.unshift({
		...entry,
		message: truncateErrorMessage(entry.message)
	});
	if (state.recentErrors.length > RECENT_ERROR_LIMIT) state.recentErrors.length = RECENT_ERROR_LIMIT;
}
const state = {
	store: new DeviceStore(join(tmpdirFallback(), "devices.json")),
	scope: new ToolScopeState({ file: join(tmpdirFallback(), "scope.json") }),
	refreshScope: () => void 0,
	identity: void 0,
	identityError: void 0,
	rateBudgetPerSecond: 32,
	perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
	connections: /* @__PURE__ */ new Map(),
	subscriptions: /* @__PURE__ */ new Map(),
	deviceStateListeners: /* @__PURE__ */ new Set(),
	pairingProgressListeners: /* @__PURE__ */ new Set(),
	disposers: [],
	connectionsBuilt: 0,
	recentErrors: []
};
/** A placeholder archive path; `apply` always replaces it before any use. */
function tmpdirFallback() {
	return join(homedir(), ".dsh", "cherry-remote");
}
/** Fans one device's state transition out to every observer (SSE, later tools). */
function publishDeviceState(event) {
	for (const listener of [...state.deviceStateListeners]) try {
		listener(event);
	} catch (error) {
		console.warn(`[cherry-remote] device-state listener threw for ${event.deviceId}`, error);
	}
}
function publishPairingProgress(event) {
	for (const listener of [...state.pairingProgressListeners]) try {
		listener(event);
	} catch (error) {
		console.warn("[cherry-remote] pairing-progress listener threw", error);
	}
}
function requireIdentity() {
	if (state.identity === void 0) {
		if (state.identityError !== void 0) {
			const reason = state.identityError instanceof Error ? state.identityError.message : String(state.identityError);
			throw new Error(`cherry-remote: the device identity FAILED to load (${reason}); fix the plugin data directory (see the logs) and re-apply the plugin`);
		}
		throw new Error("cherry-remote: the device identity is still loading; retry in a moment");
	}
	return state.identity;
}
/**
* The per-device connection pool: one lazily created {@link DeviceConnection}
* per record, kept so a device's state survives repeated reads by either face.
*
* Three rules make the pool safe, and each one guards a real defect:
*
*  - **Never await `connect()` across a cycle.** `DeviceConnection.connect()`
*    rejects on the FIRST attempt while its backoff loop keeps retrying in the
*    background, and its `#cycle` is settled without cycle-identity guarding —
*    so holding a `connect()` promise across a close-then-reconnect window can
*    surface a spurious rejection belonging to the previous cycle. The
*    assembly's flows (upsert-then-connect, evict-then-connect) therefore never
*    do; the state channel is how progress is observed, not the promise.
*  - **A terminal state is final for that INSTANCE.** `identity-mismatch`,
*    revoked grants, an incompatible protocol version and `UNAUTHENTICATED` all
*    stop the retry loop. The only repair is eviction, so the next `connect()`
*    builds a fresh instance — a terminal connection is never resurrected.
*  - **Eviction is the only way a record edit is observed.** See
*    {@link evictConnection}.
*/
function connectionFor(deviceId) {
	const existing = state.connections.get(deviceId);
	if (existing !== void 0) return existing;
	const record = state.store.list().find((device) => device.deviceId === deviceId);
	if (record === void 0) throw new Error(`cherry-remote: no device ${deviceId}`);
	const connection = new DeviceConnection({
		identity: requireIdentity(),
		record,
		rateBudgetPerSecond: state.rateBudgetPerSecond
	});
	state.connectionsBuilt += 1;
	connection.onState((deviceState) => {
		console.info(`[cherry-remote] device ${deviceId} state -> ${deviceState}`);
		publishDeviceState({
			deviceId,
			state: deviceState
		});
		if (deviceState === "offline" || deviceState === "identity-mismatch") noteError({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			deviceId,
			reason: deviceState === "identity-mismatch" ? "IDENTITY_MISMATCH" : "CONNECTION_OFFLINE",
			message: `device transitioned to ${deviceState}`
		});
		if (deviceState === "connected") recoverSubscriptions(deviceId);
	});
	connection.rpc.onNotification((method, params) => {
		try {
			subsFor(deviceId).handleNotification(method, params);
		} catch (error) {
			console.warn(`[cherry-remote] notification "${method}" for ${deviceId} failed`, error);
		}
	});
	state.connections.set(deviceId, connection);
	connection.connect().catch(() => {});
	return connection;
}
/**
* Drops one pooled connection, closing it first so a stale socket cannot
* outlive its record. The next `connect()` builds a fresh instance from the
* current store record — the only way a `DeviceConnection` can observe an
* edited address, a re-enabled flag or a RE-PAIRED record, since it captures
* its `DeviceRecord` at construction and never re-reads it.
*
* The closure is AWAITED, so a caller that has a reason to care can order
* against it: `cherry_unpair` must not delete the archive entry while the
* socket it is holding is still up. Callers that do not care (a re-apply, the
* HTTP face's maintenance paths) simply ignore the returned promise.
*
* The device's subscription layer goes with it: it is bound to the socket's rpc
* facade and its peer-negotiated cap, so keeping it would leave the next
* connection's notifications routed into a stale LRU pool. BOTH entries are
* claimed in the synchronous prefix below, which is what makes that promise
* hold for fire-and-forget callers too.
*/
async function evictConnection(deviceId) {
	const connection = state.connections.get(deviceId);
	if (connection !== void 0) state.connections.delete(deviceId);
	const subscriptions = state.subscriptions.get(deviceId);
	if (subscriptions !== void 0) state.subscriptions.delete(deviceId);
	if (subscriptions !== void 0) try {
		await subscriptions.dispose();
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} subscription dispose failed`, error);
	}
	if (connection !== void 0) try {
		await connection.close();
	} catch (error) {
		console.warn(`[cherry-remote] device ${deviceId} close failed during eviction`, error);
	}
}
/**
* Evicts EVERY pooled device, as one awaited group.
*
* The key snapshot is taken synchronously and each eviction claims its own map
* entries in the same turn, so no entry can be missed and the maps are empty by
* the time the first `await` yields — there is deliberately no `clear()` here.
* That matters for both bulk callers:
*
*  - the re-apply path (a reload with a different data dir) drops the previous
*    archive's pool, and
*  - the `ctx.effect` teardown releases it on plugin disable/unload.
*
* Both used to fire-and-forget the evictions and then `clear()` the maps, which
* raced each eviction's subscription phase: `dispose()` never ran and parked
* `cherry_wait` waiters were left to hang out their full timeout.
*
* A failure on one device never blocks the rest — each eviction already isolates
* its own errors.
*/
async function evictAllConnections() {
	const deviceIds = [...state.connections.keys()];
	for (const deviceId of [...state.subscriptions.keys()]) if (!deviceIds.includes(deviceId)) deviceIds.push(deviceId);
	await Promise.all(deviceIds.map((deviceId) => evictConnection(deviceId)));
}
/**
* The subs factory (ruling 5): the device's subscription layer, created on
* first use.
*
* `subscriptionsLimit` comes from THAT connection's hello-effective limits —
* never a constant, because the peer's advertised cap is what the local LRU has
* to stay inside (local eviction must happen BEFORE the peer can answer
* RESOURCE_EXHAUSTED). Every caller reaches this only once its device is
* `connected` (the tools refuse a non-connected device, and notifications only
* arrive on a live link), which is exactly when the hello limits are real. The
* constructor's own fallback covers the one exception: a `connected` event
* whose recovery line finds no pool yet, where nothing can be subscribed anyway.
*/
function subsFor(deviceId) {
	const existing = state.subscriptions.get(deviceId);
	if (existing !== void 0) return existing;
	const connection = connectionFor(deviceId);
	const created = new SessionSubscriptions(connection.rpc, {
		subscriptionsLimit: connection.limits.subscriptions,
		perSessionCacheBytes: state.perSessionCacheBytes
	});
	state.subscriptions.set(deviceId, created);
	console.info(`[cherry-remote] subscription layer established for ${deviceId} (peer limit ${connection.limits.subscriptions})`);
	return created;
}
/**
* The reconnect recovery line (ruling 8): every session this device had
* subscribed is re-ensured at its LAST cursor, so the peer replays only what
* this harness has not yet consumed.
*
* A failure is per-session and never aborts the rest: one session the peer
* refuses to replay must not cost the others their subscription. Nothing is
* escalated to the caller because there is no caller — the state transition
* that triggered this has already been published.
*/
async function recoverSubscriptions(deviceId) {
	const subscriptions = state.subscriptions.get(deviceId);
	if (subscriptions === void 0) return;
	const sessions = subscriptions.activeSessions();
	if (sessions.length > 0) console.info(`[cherry-remote] recovering ${sessions.length} subscription(s) for ${deviceId}: ${sessions.join(", ")}`);
	for (const sessionId of sessions) try {
		const result = subscriptions.read(sessionId);
		const cursor = "events" in result ? result.nextCursor : void 0;
		await subscriptions.ensure(sessionId, cursor);
		console.info(`[cherry-remote] subscription recovered for ${deviceId} session ${sessionId}` + (cursor === void 0 ? "" : ` at seq ${cursor.seq}`));
	} catch (error) {
		console.warn(`[cherry-remote] re-subscribing session ${sessionId} of ${deviceId} failed`, error);
	}
}
/** One dep object, shared by both faces, so there is exactly ONE pool. */
function assemblyDeps() {
	return {
		store: state.store,
		scope: state.scope,
		refreshScope: () => state.refreshScope(),
		/**
		* The pairing seam, shared by `cherry_pair` and `POST /pair`.
		*
		* The HTTP face's `pair` signature is `PairWithPayloadOptions` — it names
		* `identity` and `store` because that is what `pairWithPayload` takes — but
		* THIS closure deliberately ignores both request fields and supplies the
		* assembly's own state instead. That is the whole point of the seam: the
		* local Ed25519 key and the device archive belong to the assembly, not to
		* whoever invoked pairing, so a caller cannot pair with a different key or
		* land the record in a different store. The fields are accepted (the type
		* is the shared one) and overridden here, in one visible place, rather
		* than being silently passed through.
		*/
		pair: async (request) => {
			const record = await pairWithPayload({
				identity: requireIdentity(),
				payload: request.payload,
				store: state.store,
				...request.name === void 0 ? {} : { name: request.name },
				onVerificationCode: request.onVerificationCode,
				onStatus: (stage) => publishPairingProgress({ stage })
			});
			await evictConnection(record.deviceId);
			return record;
		},
		identity: requireIdentity,
		connect: connectionFor,
		detach: (deviceId) => state.connections.get(deviceId),
		evict: evictConnection,
		subs: subsFor,
		onDeviceState: (cb) => {
			state.deviceStateListeners.add(cb);
			return () => {
				state.deviceStateListeners.delete(cb);
			};
		},
		onPairingProgress: (cb) => {
			state.pairingProgressListeners.add(cb);
			return () => {
				state.pairingProgressListeners.delete(cb);
			};
		},
		diagnosticsStats: () => ({
			connections: state.connections.size,
			sockets: [...state.connections.values()].filter((connection) => connection.state === "connected").length,
			connectionsBuilt: state.connectionsBuilt,
			subscriptions: [...state.subscriptions.values()].reduce((total, layer) => total + layer.activeSessions().length, 0)
		}),
		diagnosticsSessions: () => [...state.subscriptions.entries()].flatMap(([deviceId, layer]) => layer.activeSessions().map((sessionId) => {
			const cursor = layer.cursorOf(sessionId);
			return {
				deviceId,
				sessionId,
				subscriptions: 1,
				...cursor === void 0 ? {} : { cursor }
			};
		})),
		diagnosticsErrors: () => [...state.recentErrors],
		diagnosticsConfig: () => ({
			rateBudgetPerSecond: state.rateBudgetPerSecond,
			perSessionCacheBytes: state.perSessionCacheBytes
		}),
		onArchiveQuarantined: (error) => {
			noteError({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				reason: "ARCHIVE_QUARANTINED",
				message: `device archive ${error.file} is unreadable; it was preserved as ${error.corruptPath ?? `${error.file}.corrupt`} and the archive is READ-ONLY until that file is moved aside`
			});
		}
	};
}
function apply(ctx, config = {}) {
	const dataDir = resolveDataDir(config);
	const bridgeConfig = resolveBridgeConfig(config);
	state.rateBudgetPerSecond = bridgeConfig.rateBudgetPerSecond;
	state.perSessionCacheBytes = bridgeConfig.perSessionCacheBytes;
	state.store = new DeviceStore(join(dataDir, "devices.json"));
	state.recentErrors.length = 0;
	state.connectionsBuilt = 0;
	for (const dispose of state.disposers.splice(0)) try {
		dispose();
	} catch (error) {
		console.warn("[cherry-remote] releasing the previous assembly failed", error);
	}
	evictAllConnections();
	const scope = new ToolScopeState({ file: join(dataDir, "scope.json") });
	scope.load();
	state.scope = scope;
	state.refreshScope = () => host.refresh();
	const deps = assemblyDeps();
	state.disposers.push(registerHttpApi(ctx, deps));
	ctx.effect?.(() => () => {
		for (const dispose of state.disposers.splice(0)) try {
			dispose();
		} catch (error) {
			console.warn("[cherry-remote] releasing the assembly failed", error);
		}
		state.deviceStateListeners.clear();
		state.pairingProgressListeners.clear();
		return evictAllConnections();
	});
	const host = createToolScopeHost({
		scope,
		names: CHERRY_TOOL_NAMES,
		registerTools: () => registerAtomically(ctx, (toolsCtx) => registerCherryTools(toolsCtx, deps))
	});
	state.disposers.push(host.mount(ctx));
	loadOrCreateIdentity(dataDir).then((identity) => {
		state.identity = identity.key;
		state.identityError = void 0;
	}, (error) => {
		state.identityError = error;
		console.error("[cherry-remote] failed to load the device identity", error);
		noteError({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			reason: "IDENTITY_LOAD_FAILED",
			message: error instanceof Error ? error.message : String(error)
		});
	});
}
//#endregion
export { DEFAULT_PER_SESSION_CACHE_BYTES, DEFAULT_RATE_BUDGET_PER_SECOND, apply, inject, name, noteError, resolveBridgeConfig, resolveDataDir };
