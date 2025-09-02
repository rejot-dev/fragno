import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { finishServerLoad, startServerLoad, initServerLoad } from "@rejot-dev/fragno";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  console.time("initServerLoad");
  await initServerLoad();

  // First pass: render the app to discover all the stores
  const firstPassContext = { ...routerContext, serverHandoffStream: undefined };
  renderToString(<ServerRouter context={firstPassContext} url={request.url} />);
  console.timeEnd("initServerLoad");

  console.time("startServerLoad");
  const javascriptToEmbed = await startServerLoad();
  console.timeEnd("startServerLoad");

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <>
        <script
          dangerouslySetInnerHTML={{
            __html: javascriptToEmbed,
          }}
        />
        <ServerRouter context={routerContext} url={request.url} />
      </>,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          finishServerLoad();

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
