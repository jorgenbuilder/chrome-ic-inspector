import {
    ReadRequest,
    CallRequest,
    requestIdOf,
    Certificate,
    Expiry,
    HttpAgent,
    RequestStatusResponseStatus,
    QueryResponseStatus,
} from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { decode as cborDecode } from 'cbor-x';
import { toHexString } from 'ictool';

import {
    CandidDecodeResult,
    decodeCandidArgs,
    decodeCandidVals,
} from './candid';
import { asPrincipal, base64ToBytes } from './common';

/////////////////////
// Decode Request //
///////////////////

export type RequestType = 'query' | 'call' | 'read_state';
type InternetComputerRequest = ReadRequest | CallRequest;

interface AbstractDecodedRequest {
    message: string;
    requestId: string;
    canisterId: string;
    method: string;
    sender: Principal;
    requestType: RequestType;
    ingressExpiry: Expiry;
    boundary: URL;
}

interface DecodedCallRequest extends AbstractDecodedRequest {
    paths: ArrayBuffer[][];
}

// TODO: This type poorly thought out. "Read" seems to indicate "read_state", but that request type has no args param.
export interface DecodedReadRequest extends AbstractDecodedRequest {
    args: {
        result: any;
        withInterface: boolean;
    };
}

export type DecodedRequest = DecodedCallRequest | DecodedReadRequest;

const boundaryNodeRegex =
    /https?:\/\/(?:.+)?((?:ic0\.app|dfinity.network)|localhost:[0-9]+)\/api\/v2\/canister\/(.+)\/(query|call|read_state)/;

/**
 * Determines whether a URL represents a request to an internet computer boundary node.
 */
export function isBoundaryNodeURL(url: string): boolean {
    return Boolean(url.match(boundaryNodeRegex));
}

/**
 * Determines whether a network event is an internet computer request/response that we want to record.
 */
function shouldCapture(event: chrome.devtools.network.Request) {
    return (
        isBoundaryNodeURL(event.request.url) && event.request.method === 'POST'
    );
}

// A read_state requests doesn't include critical information about the original call request, so we track this data in memory.
const messageDetails: {
    [key: string]: {
        canisterId: string;
        method: string;
    };
} = {};

/**
 * Decode the body of an internet computer request.
 */
async function decodeRequest(
    event: chrome.devtools.network.Request,
): Promise<DecodedRequest> {
    if (!event.request.postData?.text) {
        throw new Error('Could not retrieve post data for request');
    }

    const requestText = event.request.postData.text;

    // Chrome encodes the string into a latin character set. We reverse that.
    const b64 = window.btoa(requestText);

    // The network request text is a B64 encoded string. We decode to bytes.
    const bytes = base64ToBytes(b64);

    // The resulting bytes are encoded in CBOR. We decode to an InternetComputerRequest.
    const result: { content: InternetComputerRequest } = cborDecode(bytes);

    // Validate the decoded content (not even sure where the content key comes from...)
    if (!('content' in result)) {
        console.error(result);
        throw new Error(
            `Unreachable: unexpected missing "content" key in decode.`,
        );
    }

    // Validate the request.
    const request = result.content;
    if (
        !('request_type' in request) ||
        !['query', 'call', 'read_state'].includes(request.request_type)
    ) {
        console.error('Unexpected request', request);
        throw new Error(`Unreachable: unexpected result decoded from request.`);
    }

    // Following parameters are common to all request types.
    const sender = asPrincipal(request.sender);
    const requestType = request.request_type;
    const ingressExpiry = request.ingress_expiry;
    const requestId = toHexString([...new Uint8Array(requestIdOf(request))]);
    const boundary = new URL(event.request.url);

    if (requestType === 'query' || requestType === 'call') {
        // These parameters common to "call" and "query" requests.
        const canisterId = asPrincipal(request.canister_id).toText();
        const method = request.method_name;

        // This parameter allows us to determine which original ic message a request is concerned with
        const message = requestId;
        // NOTE: Bad side effect. Why does putting this below the next await cause the value not to be set when accessed in decodeRequest?
        messageDetails[message] = {
            canisterId: canisterId,
            method,
        };
        const args = await decodeCandidArgs(canisterId, method, request.arg);

        return {
            boundary,
            message,
            requestId,
            sender,
            requestType,
            ingressExpiry,
            canisterId,
            method,
            args,
        };
    } else {
        // These parameters only on "read_state" requests
        const paths = request.paths;

        // The lookup path provided in "read_state" request is the requestId of the original "call" request
        const message = toHexString([...new Uint8Array(request.paths[0][1])]);

        const { method, canisterId } = messageDetails[message];
        return {
            boundary,
            message,
            requestId,
            canisterId,
            method,
            sender,
            requestType,
            ingressExpiry,
            paths,
        };
    }
}

//////////////////////
// Decode Response //
////////////////////

interface DecodedQueryResponse {
    status: QueryResponseStatus;
}

interface RepliedQueryResponse extends DecodedQueryResponse {
    reply: CandidDecodeResult;
}

export interface RejectedResponse extends DecodedQueryResponse {
    message: string;
    code: number;
}

interface DecodedReadStateResponse {
    status: RequestStatusResponseStatus;
}

interface RepliedReadStateResponse extends DecodedReadStateResponse {
    reply: CandidDecodeResult;
}

export type DecodedResponse =
    | DecodedQueryResponse
    | RepliedQueryResponse
    | DecodedReadStateResponse
    | RepliedReadStateResponse
    | RejectedResponse;

async function decodeResponse(
    event: chrome.devtools.network.Request,
    request: DecodedRequest,
): Promise<DecodedResponse> {
    // We retrieve the response text through chrome's async api
    const content = (await new Promise<string>((res) =>
        event.getContent((content) => res(content)),
    )) as string | undefined;

    if (!content) {
        console.warn(
            `Received empty response. This is expected for empty 202 call responses, and http_request, but there may be other unknown cases.`,
        );
        return { status: RequestStatusResponseStatus.Unknown };
    }

    // The resulting content is a B64 encoded string. We decode to byes.
    const bytes = base64ToBytes(content);

    // The resulting bytes are encoded in CBOR. We decode to an InternetComputerResponse.
    const response = cborDecode(bytes);

    // Validate the response
    if (
        !response ||
        (!('status' in response) &&
            !('certificate' in response) &&
            !('requestId' in response))
    ) {
        console.error('Unexpected response', response, event);
        throw new Error(
            `Unreachable: unexpected result decoded from response.`,
        );
    }

    if ('status' in response) {
        // Validate we have corresponding query request
        if (request.requestType !== 'query') {
            throw new Error(
                'Unreachable: query response follows query request.',
            );
        }
        const { canisterId, method } = request as DecodedReadRequest;

        // These parameters exist on query response
        const status = response.status;
        if (status === 'replied') {
            // These parameters exist on successful query response
            const reply = await decodeCandidVals(
                canisterId,
                method,
                response.reply.arg,
            );
            return { status, reply };
        } else {
            // These parameters exist on failed query response
            const message = response.reject_message;
            const code = response.reject_code;
            return { status, message, code };
        }
    } else if ('certificate' in response) {
        // Validate we have corresponding read_state request
        if (request.requestType !== 'read_state') {
            throw new Error(
                'Unreachable: read_state response follows read_state request.',
            );
        }
        const { paths, message } = request as DecodedCallRequest;

        // Validate the request path
        const p1 = new TextDecoder().decode(paths[0][0]);
        if (p1 !== 'request_status') {
            throw new Error(`Unexpected first path fragment: ${p1}`);
        }

        const details = messageDetails[message];

        if (!details) {
            console.log(messageDetails);
            throw new Error(
                `Unreachable: could not retrieve canister and method: ${message}`,
            );
        }

        const { canisterId, method } = details;

        const cert = new Certificate(response, new HttpAgent());
        // manipulating the private `verified` property to bypass BLS verification. This is fine for debugging purposes, but it breaks the security model of the IC, so logs in the extension will not be trustable. There's a pure js BLS lib, but it will take 8 seconds to verify each certificate. There's a much faster WASM lib, but chrome extensions make that a pain (could be something worth implementing in the sandbox.)
        (cert as any).verified = true;

        const status = (function () {
            const result = cert.lookup([
                ...paths.flat(),
                new TextEncoder().encode('status'),
            ]);
            if (result instanceof ArrayBuffer) {
                const status = new TextDecoder().decode(result);
                return status as RequestStatusResponseStatus;
            }
            // Missing requestId means we need to wait
            return RequestStatusResponseStatus.Unknown;
        })();

        switch (status) {
            case RequestStatusResponseStatus.Replied: {
                const buffer = cert.lookup([...paths.flat(), 'reply']);
                if (!buffer) {
                    throw new Error(
                        'Unreachable: successful read_state must have reply',
                    );
                }
                const reply = await decodeCandidVals(
                    canisterId,
                    method,
                    buffer,
                );
                return { status, reply } as RepliedReadStateResponse;
            }

            case RequestStatusResponseStatus.Received:
            case RequestStatusResponseStatus.Unknown:
            case RequestStatusResponseStatus.Processing:
                return { status };

            case RequestStatusResponseStatus.Rejected: {
                const code = new Uint8Array(
                    cert.lookup([...paths.flat(), 'reject_code'])!,
                )[0];
                const message = new TextDecoder().decode(
                    cert.lookup([...paths.flat(), 'reject_message'])!,
                );
                return { status, message, code };
            }

            case RequestStatusResponseStatus.Done:
                throw new Error(
                    `Call was marked as done but we never saw the reply`,
                );
        }
    } else {
        throw 'TODO: Call responses';
    }
}

/**
 * Filter and decode internet computer message from a chrome network event.
 */
export async function captureInternetComputerMessageFromNetworkEvent(
    event: chrome.devtools.network.Request,
): Promise<
    | {
          request: DecodedRequest;
          response: DecodedResponse;
      }
    | undefined
> {
    if (!shouldCapture(event)) return;

    console.debug('Full network event stub', event);

    const request = await decodeRequest(event);
    console.debug(decodeRequest.name, request);

    const response = await decodeResponse(event, request);
    console.debug(decodeResponse.name, response);

    return { request, response };
}
