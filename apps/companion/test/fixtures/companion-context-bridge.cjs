const { strict: assert } = require("node:assert");
const { deflateSync } = require("node:zlib");

const { app, BrowserWindow, ipcMain } = require("electron");

const CHANNEL = "tokenmonster:companion:save-png";
const FILE_NAME = "tokenmonster-local-share-card.png";
const preloadPath = process.env["TOKENMONSTER_TEST_COMPANION_PRELOAD"];

if (typeof preloadPath !== "string" || preloadPath.length === 0) {
  throw new Error("missing companion preload path");
}

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type, data) {
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  output.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(
    crc32(output.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength
  );
  return output;
}

function pngFixture() {
  const width = 1_200;
  const height = 630;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
      chunk("IEND", new Uint8Array())
    ])
  );
}

const timeout = setTimeout(() => {
  process.stderr.write("Electron context-bridge PNG integration timed out.\n");
  app.exit(1);
}, 20_000);

void app
  .whenReady()
  .then(async () => {
    const expected = pngFixture();
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true
      }
    });
    ipcMain.handle(CHANNEL, (event, request) => {
      assert.equal(event.sender, window.webContents);
      assert.equal(event.senderFrame, window.webContents.mainFrame);
      assert.deepEqual(Reflect.ownKeys(request), ["bytes", "suggestedName"]);
      assert.equal(request.suggestedName, FILE_NAME);
      assert.equal(request.bytes instanceof Uint8Array, true);
      assert.equal(Object.getPrototypeOf(request.bytes), Uint8Array.prototype);
      assert.equal(Buffer.isBuffer(request.bytes), false);
      assert.deepEqual(new Uint8Array(request.bytes), expected);
      return Object.freeze({ status: "saved" });
    });
    await window.loadURL("data:text/html,<meta charset=utf-8><title>bridge</title>");
    const result = await window.webContents.executeJavaScript(
      `(async () => {
        const bytes = new Uint8Array(${JSON.stringify([...expected])});
        return window.tokenMonsterCompanion.savePng({
          bytes,
          suggestedName: ${JSON.stringify(FILE_NAME)}
        });
      })()`
    );
    assert.deepEqual(result, { status: "saved" });
    clearTimeout(timeout);
    ipcMain.removeHandler(CHANNEL);
    window.destroy();
    process.stdout.write(
      "Verified actual Electron renderer Uint8Array -> contextBridge -> ipcMain.\n"
    );
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    ipcMain.removeHandler(CHANNEL);
    process.stderr.write(
      `${error instanceof Error ? error.stack : "Electron bridge verification failed"}\n`
    );
    app.exit(1);
  });
