const boundaryNodeRegex =
    /https?:\/\/(?:.+)?((?:ic0\.app|dfinity.network|icp-api.io|icp0.io|mainnet.plugwallet.ooo)|localhost:[0-9]+)\/api\/v(2|3)\/canister\/(.+)\/(query|call|read_state)/;

/**
 * Determines whether a URL represents a request to an internet computer boundary node.
 */
export function isBoundaryNodeURL(url: string): boolean {
    return Boolean(url.match(boundaryNodeRegex));
}

/**
 * Determines the presence of known ic-related headers in a network request. These headers have been found
 * to be less reliable than the URL regex, but they do catch some cases that would otherwise be missed.
 */
export function hasICHeaders(event: chrome.devtools.network.Request): boolean {
    return !!event.response.headers.find((h) => h.name.includes('x-ic-'));
}

/**
 * Determines whether the request uses a cbor content type.
 */
export function isCBOR(event: chrome.devtools.network.Request): boolean {
    return event.response.headers.some(
        (h) => h.name === 'content-type' && h.value.includes('cbor'),
    );
}

/**
 * Determines whether a network event is an internet computer request/response that we want to record.
 * We rely solely on matching the url against a regex representing known boundary nodes. x-ic- headers
 * proved less reliable.
 */
export function shouldCapture(event: chrome.devtools.network.Request): boolean {
    // Let's try out a CBOR-only approach for now.
    return isCBOR(event);
}
