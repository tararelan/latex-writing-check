import * as vscode from 'vscode';

// node-llama-cpp v3 ships as native ESM ("type": "module" in its
// package.json). This extension compiles to CommonJS (like every VS Code
// extension), and TypeScript's compiler rewrites a plain `await
// import('node-llama-cpp')` into `require('node-llama-cpp')` when targeting
// CommonJS -- which throws (ERR_REQUIRE_ESM) for an ESM-only package. The
// `new Function(...)` indirection below produces a dynamic import() call
// that TypeScript can't see (and therefore can't rewrite), so Node's own
// native, CJS-can-load-ESM dynamic import actually runs. This is a common,
// deliberate workaround for this exact CJS/ESM interop gap, not a hack
// specific to this project.
const importDynamic = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<any>;

const MODEL_FILENAME = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';

// Same model Ollama already defaults to (latexWritingCheck.model's default
// of "qwen2.5:1.5b-instruct" is the Ollama tag for this same model) -- picked
// so writing-quality checks behave consistently whichever local backend is
// used, and because a ~1GB download is a reasonable one-time cost for a
// bundled model, unlike a larger/more capable one.
const MODEL_URL = 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf';

let llamaModulePromise: Promise<any> | undefined;
function loadLlamaModule(): Promise<any> {
  if (!llamaModulePromise) {
    llamaModulePromise = importDynamic('node-llama-cpp');
  }
  return llamaModulePromise;
}

function modelPath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, MODEL_FILENAME);
}

export async function isModelDownloaded(context: vscode.ExtensionContext): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(modelPath(context));
    return true;
  } catch {
    return false;
  }
}

async function downloadModel(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string> {
  const dest = modelPath(context);
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  progress.report({ message: 'Downloading local model (~1GB, one-time only)…' });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the bundled model: ${res.status} ${res.statusText}. Check your network connection and try again, or switch latexWritingCheck.provider away from "bundled".`);
  }

  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastReportedPercent = -1;
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();

  while (true) {
    if (token.isCancellationRequested) {
      throw new Error('Model download cancelled.');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        const percent = Math.floor((received / total) * 100);
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          progress.report({ message: `Downloading local model… ${percent}%` });
        }
      }
    }
  }

  // Written to a temp path and renamed into place at the end, so a
  // cancelled or interrupted download never leaves a corrupt-but-present
  // file that a later run mistakes for a complete one and tries to load.
  const tmpDest = vscode.Uri.file(dest.fsPath + '.part');
  const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
  await vscode.workspace.fs.writeFile(tmpDest, buffer);
  await vscode.workspace.fs.rename(tmpDest, dest, { overwrite: true });

  return dest.fsPath;
}

let sessionPromise: Promise<any> | undefined;

async function getSession(context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      let path: string;
      if (await isModelDownloaded(context)) {
        path = modelPath(context).fsPath;
      } else {
        // The download is a one-off, potentially multi-minute event on a
        // slow connection -- worth its own visible, cancellable progress
        // notification rather than tying up whatever notification (or none)
        // the calling check happened to already show.
        path = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'LaTeX Writing Check: setting up the bundled local model',
            cancellable: true
          },
          (progress, innerToken) => downloadModel(context, progress, innerToken)
        );
      }

      const { getLlama, LlamaChatSession } = await loadLlamaModule();
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: path });
      const llamaContext = await model.createContext();
      return new LlamaChatSession({ contextSequence: llamaContext.getSequence() });
    })();

    // If setup failed, don't leave the failed promise cached -- otherwise
    // every future check would immediately fail again with the same error
    // (e.g. a one-off network blip during download) with no way to recover
    // short of reloading the window.
    sessionPromise.catch(() => {
      sessionPromise = undefined;
    });
  }
  return sessionPromise;
}

/**
 * Runs one chat completion against the bundled local model, downloading and
 * loading it on first use if necessary (see getSession above). Slower to
 * first respond than Ollama the very first time -- loading a ~1GB model
 * into memory on a CPU takes real time -- but needs nothing installed
 * separately: no Ollama app, no `ollama serve`, no PATH setup, nothing
 * outside this extension itself.
 */
export async function chatBundled(
  systemPrompt: string,
  userContent: string,
  context: vscode.ExtensionContext,
  token?: vscode.CancellationToken
): Promise<string> {
  const session = await getSession(context, token);
  const response = await session.prompt(`${systemPrompt}\n\n${userContent}`, {
    temperature: 0.1
  });
  return String(response).trim();
}
