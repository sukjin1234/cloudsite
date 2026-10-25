const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const SevenZip = require("7z-wasm");

function toWasmPath(value, root) {
  return path.posix.join("/nodefs", path.relative(root, value).split(path.sep).join("/"));
}

(async () => {
  const archiveRoot = path.parse(workerData.archivePath).root;
  const output = [];
  const errors = [];
  let exitCode = 0;
  try {
    const sevenZip = await SevenZip({
      stdout: (value) => { if (value !== null) output.push(value); },
      stderr: (value) => { if (value !== null) errors.push(value); },
      quit: (code) => { exitCode = code; }
    });
    const originalChmod = sevenZip.FS.chmod;
    sevenZip.FS.chmod = function (target, mode, dontFollow) {
      if (mode) originalChmod(target, mode, dontFollow);
    };
    sevenZip.FS.mkdir("/nodefs");
    sevenZip.FS.mount(sevenZip.NODEFS, { root: archiveRoot }, "/nodefs");
    const archivePath = toWasmPath(workerData.archivePath, archiveRoot);
    if (workerData.type === "list") {
      sevenZip.callMain(["l", "-slt", archivePath]);
    } else if (workerData.type === "extract") {
      const outputPath = toWasmPath(workerData.outputPath, archiveRoot);
      sevenZip.callMain(["x", archivePath, "-o" + outputPath, "-y", workerData.entryPath]);
    } else {
      const sourcePath = toWasmPath(workerData.sourcePath, archiveRoot);
      const outputPath = toWasmPath(workerData.outputPath, archiveRoot);
      sevenZip.FS.chdir(sourcePath);
      sevenZip.callMain(["a", "-t7z", outputPath, "."]);
    }
    if (exitCode !== 0) throw new Error(Buffer.from(errors).toString("utf8") || "압축 파일을 읽지 못했습니다.");
    parentPort.postMessage({ output: Buffer.from(output).toString("utf8"), ok: true });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "압축 파일을 읽지 못했습니다.", ok: false });
  } finally {
    parentPort.close();
  }
})();
