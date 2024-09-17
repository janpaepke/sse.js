/**
 * sse.js - A flexible EventSource polyfill/replacement.
 * https://github.com/mpetazzoni/sse.js
 *
 * Copyright (C) 2016-2024 Maxime Petazzoni <maxime.petazzoni@bulix.org>.
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

type Callback = (event: SSEvent) => void;
type Payload = Blob | ArrayBuffer | DataView | FormData | URLSearchParams | string;

export interface SSEvent extends Event {
	// TODO: This is unnecessary! Instead the callback should be bound to the instance, as is common practice (same as EventSource does).
	source: SSE;
	id: string;
	data: string;
}
export interface ReadyStateEvent extends SSEvent {
	readyState: number;
}

export type SSEHeaders = Record<string, string>;
export interface SSEOptions {
	/**
	 * - headers
	 */
	headers?: SSEHeaders;
	/**
	 * - payload as a Blob, ArrayBuffer, Dataview, FormData, URLSearchParams, or string
	 */
	payload?: Payload;
	/**
	 * - HTTP Method
	 */
	method?: string;
	/**
	 * - flag, if credentials needed
	 */
	withCredentials?: boolean;
	/**
	 * - flag, if streaming should start automatically
	 */
	start?: boolean;
	/**
	 * - debugging flag
	 */
	debug?: boolean;
}

const noop = () => {};

// TODO: consider actually implementing EventSource interface to enforce compatibility
export class SSE /* implements EventSource */ {
	public readonly INITIALIZING = -1;
	public readonly CONNECTING = 0;
	public readonly OPEN = 1;
	public readonly CLOSED = 2;

	// TODO: All of these should probably be readonly
	public headers: Record<string, string>;
	public payload: Payload;
	public method: string;
	public withCredentials: boolean;
	public debug: boolean;
	public readyState = this.INITIALIZING;
	// TODO: this is non-standard and documented nowhere. Do we need this?
	public FIELD_SEPARATOR = ":";

	protected progress = 0;
	protected chunk = "";
	protected xhr: XMLHttpRequest | null = null;
	protected listeners: Record<string, Callback[]> = {};

	// TODO: Check if this is the expected way to define these properties
	public onmessage: (event: SSEvent) => void = noop;
	public onopen: (event: SSEvent) => void = noop;
	public onload: (event: SSEvent) => void = noop;
	public onreadystatechange: (event: ReadyStateEvent) => void = noop;
	public onerror: (event: SSEvent) => void = noop;
	public onabort: (event: SSEvent) => void = noop;

	constructor(public url: string, options: SSEOptions = {}) {
		this.headers = options.headers ?? {};
		this.payload = options.payload ?? "";
		this.method = options.method ?? (this.payload ? "POST" : "GET");
		this.withCredentials = options.withCredentials ?? false;
		this.debug = options.debug ?? false;

		if (options.start !== false) {
			this.stream();
		}
	}

	public addEventListener(type: string, listener: Callback): void {
		if (this.listeners[type] === undefined) {
			this.listeners[type] = [];
		}
		if (!this.listeners[type].includes(listener)) {
			this.listeners[type].push(listener);
		}
	}

	public removeEventListener(type: string, listener: Callback): void {
		if (this.listeners[type] === undefined) {
			return;
		}

		const filtered = this.listeners[type].filter(l => l !== listener);

		if (filtered.length === 0) {
			delete this.listeners[type];
		} else {
			this.listeners[type] = filtered;
		}
	}

	public dispatchEvent(event: SSEvent | null): boolean {
		if (!event) {
			return true;
		}

		if (this.debug) {
			console.debug(event);
		}

		event.source = this;

		const onHandler = "on" + event.type;
		if (this.hasOwnProperty(onHandler)) {
			// @ts-expect-error // TODO: We might want to do this differently, i.e. constrain the types of overrideable methods more strictly.
			this[onHandler].call(this, event);
			if (event.defaultPrevented) {
				return false;
			}
		}

		if (this.listeners[event.type]) {
			return this.listeners[event.type].every(callback => {
				callback(event);
				return !event.defaultPrevented;
			});
		}

		return true;
	}

	public stream(): void {
		if (this.xhr) {
			// Already connected.
			return;
		}

		this._setReadyState(this.CONNECTING);

		this.xhr = new XMLHttpRequest();
		this.xhr.addEventListener("progress", this._onStreamProgress.bind(this));
		this.xhr.addEventListener("load", this._onStreamLoaded.bind(this));
		this.xhr.addEventListener("readystatechange", this._checkStreamClosed.bind(this));
		this.xhr.addEventListener("error", this._onStreamFailure.bind(this));
		this.xhr.addEventListener("abort", this._onStreamAbort.bind(this));
		this.xhr.open(this.method, this.url);
		for (const header in this.headers) {
			this.xhr.setRequestHeader(header, this.headers[header]);
		}
		this.xhr.withCredentials = this.withCredentials;
		this.xhr.send(this.payload);
	}

	public close(): void {
		if (this.readyState === this.CLOSED || !this.xhr) {
			return;
		}
		this.xhr.abort();
		this.xhr = null;
		this._setReadyState(this.CLOSED);
	}

	protected _setReadyState(state: number): void {
		var event = new CustomEvent("readystatechange");
		// @ts-expect-error // TODO: is this supposed to be a ReadyStateEvent? If so, dispatchEvent needs to allow it and it's missing the source property.
		event.readyState = state;
		this.readyState = state;
		//@ts-expect-error // TODO: confirm correct event type
		this.dispatchEvent(event);
	}

	protected _onStreamFailure(e: ProgressEvent): void {
		const event = new CustomEvent("error");
		//@ts-expect-error // TODO: this is not a known property of CustomEvent. Do we want to use event.detail?
		event.data = e.currentTarget.response;
		//@ts-expect-error // TODO: confirm correct event type
		this.dispatchEvent(event);
		this.close();
	}

	protected _onStreamAbort(): void {
		// @ts-expect-error // TODO: What is the correct event type here?
		this.dispatchEvent(new CustomEvent("abort"));
		this.close();
	}

	protected _onStreamProgress(e: ProgressEvent): void {
		if (!this.xhr) {
			return;
		}

		if (this.xhr.status !== 200) {
			this._onStreamFailure(e);
			return;
		}

		if (this.readyState === this.CONNECTING) {
			// @ts-expect-error // TODO: What is the correct event type here?
			this.dispatchEvent(new CustomEvent("open"));
			this._setReadyState(this.OPEN);
		}

		const data = this.xhr.responseText.substring(this.progress);

		this.progress += data.length;
		const parts = (this.chunk + data).split(/(\r\n\r\n|\r\r|\n\n)/g);

		// we assume that the last chunk can be incomplete because of buffering or other network effects
		// so we always save the last part to merge it with the next incoming packet
		const lastPart = parts.pop();
		parts.forEach(part => {
			if (part.trim().length > 0) {
				// @ts-expect-error // TODO: What is the correct event type here?
				this.dispatchEvent(this._parseEventChunk(part));
			}
		});
		// @ts-expect-error // TODO: lastPart can be undefined, what should happen here?
		this.chunk = lastPart;
	}

	protected _onStreamLoaded(e: ProgressEvent): void {
		this._onStreamProgress(e);

		// Parse the last chunk.
		// @ts-expect-error // TODO: What is the correct event type here?
		this.dispatchEvent(this._parseEventChunk(this.chunk));
		this.chunk = "";
	}

	/**
	 * Parse a received SSE event chunk into a constructed event object.
	 *
	 * Reference: https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
	 */
	protected _parseEventChunk(chunk: string): CustomEvent | null {
		if (!chunk || chunk.length === 0) {
			return null;
		}

		if (this.debug) {
			console.debug(chunk);
		}

		// TODO: what is this? Where should this typedef go?
		const eventFields: { id: string | null; retry: string | null; data: string | null; event: string | null } = {
			id: null,
			retry: null,
			data: null,
			event: null,
		};
		chunk.split(/\n|\r\n|\r/).forEach(line => {
			const index = line.indexOf(this.FIELD_SEPARATOR);
			let field: string, value: string;

			if (index > 0) {
				// only first whitespace should be trimmed
				const skip = line[index + 1] === " " ? 2 : 1;
				field = line.substring(0, index);
				value = line.substring(index + skip);
			} else if (index < 0) {
				// Interpret the entire line as the field name, and use the empty string as the field value
				field = line;
				value = "";
			} else {
				// A colon is the first character. This is a comment; ignore it.
				return;
			}

			if (!(field in eventFields)) {
				return;
			}

			// consecutive 'data' is concatenated with newlines
			if (field === "data" && eventFields[field] !== null) {
				eventFields.data += "\n" + value;
			} else {
				// @ts-expect-error // TODO: Improve key type inference
				eventFields[field] = value;
			}
		});

		const event = new CustomEvent(eventFields.event || "message");
		// @ts-expect-error // TODO: data is not a known property of CustomEvent
		event.data = eventFields.data ?? "";
		// @ts-expect-error // TODO: id is not a known property of CustomEvent
		event.id = eventFields.id;
		return event;
	}

	protected _checkStreamClosed(): void {
		if (!this.xhr) {
			return;
		}

		if (this.xhr.readyState === XMLHttpRequest.DONE) {
			this._setReadyState(this.CLOSED);
		}
	}
}
