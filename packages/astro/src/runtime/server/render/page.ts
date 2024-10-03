import { type NonAstroPageComponent, renderComponentToString } from './component.js';
import type { AstroComponentFactory } from './index.js';

import type { RouteData, SSRResult } from '../../../types/public/internal.js';
import { isAstroComponentFactory } from './astro/index.js';
import { renderToAsyncIterable, renderToReadableStream, renderToString } from './astro/render.js';
import { encoder } from './common.js';
import { isDeno, isNode } from './util.js';

function readableStreamFromAsyncIterable(
	asyncIterable: AsyncIterable<Uint8Array>,
) {
	const iterator = asyncIterable[Symbol.asyncIterator]();
	return new ReadableStream(
		{
			async pull(controller) {
				try {
					const { value, done } = await iterator.next();
					if (done) {
						controller.close();
					} else {
						controller.enqueue(value);
					}
				} catch (err) {
					controller.error(err);
				}
			}
		},
	);
}

export async function renderPage(
	result: SSRResult,
	componentFactory: AstroComponentFactory | NonAstroPageComponent,
	props: any,
	children: any,
	streaming: boolean,
	route?: RouteData,
): Promise<Response> {
	if (!isAstroComponentFactory(componentFactory)) {
		result._metadata.headInTree =
			result.componentMetadata.get((componentFactory as any).moduleId)?.containsHead ?? false;

		const pageProps: Record<string, any> = { ...(props ?? {}), 'server:root': true };

		const str = await renderComponentToString(
			result,
			componentFactory.name,
			componentFactory,
			pageProps,
			{},
			true,
			route,
		);

		const bytes = encoder.encode(str);

		return new Response(bytes, {
			headers: new Headers([
				['Content-Type', 'text/html; charset=utf-8'],
				['Content-Length', bytes.byteLength.toString()],
			]),
		});
	}

	// Mark if this page component contains a <head> within its tree. If it does
	// We avoid implicit head injection entirely.
	result._metadata.headInTree =
		result.componentMetadata.get(componentFactory.moduleId!)?.containsHead ?? false;

	let body: BodyInit | Response;
	if (streaming) {
		// isNode is true in Deno node-compat mode but response construction from
		// async iterables is not supported, so we fallback to ReadableStream if isDeno is true.
		if (isNode && !isDeno) {
			const nodeBody = await renderToAsyncIterable(
				result,
				componentFactory,
				props,
				children,
				true,
				route,
			);
			body = nodeBody instanceof Response ? nodeBody : readableStreamFromAsyncIterable(nodeBody);
		} else {
			body = await renderToReadableStream(result, componentFactory, props, children, true, route);
		}
	} else {
		body = await renderToString(result, componentFactory, props, children, true, route);
	}

	// If the Astro component returns a Response on init, return that response
	if (body instanceof Response) return body;

	// Create final response from body
	const init = result.response;
	const headers = new Headers(init.headers);
	// For non-streaming, convert string to byte array to calculate Content-Length
	if (!streaming && typeof body === 'string') {
		body = encoder.encode(body);
		headers.set('Content-Length', body.byteLength.toString());
	}
	// TODO: Revisit if user should manually set charset by themselves in Astro 4
	// This code preserves the existing behaviour for markdown pages since Astro 2
	if (route?.component.endsWith('.md')) {
		headers.set('Content-Type', 'text/html; charset=utf-8');
	}
	let status = init.status;
	// Custom 404.astro and 500.astro are particular routes that must return a fixed status code
	if (route?.route === '/404') {
		status = 404;
	} else if (route?.route === '/500') {
		status = 500;
	}
	if (status) {
		return new Response(body, { ...init, headers, status });
	} else {
		return new Response(body, { ...init, headers });
	}
}
