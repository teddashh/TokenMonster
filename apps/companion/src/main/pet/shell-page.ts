export type PetShellStatus =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "error"; message: string }>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function petShellPage(
  status: PetShellStatus,
  pinned: boolean
): string {
  const content =
    status.kind === "error"
      ? `<main class="notice" role="alert">
          <div class="monster" aria-hidden="true">●ᴥ●</div>
          <h1>TokenMonster 暫時睡著了</h1>
          <p>${escapeHtml(status.message)}</p>
          <button class="retry" id="retry" type="button">再試一次</button>
        </main>`
      : status.kind === "loading"
        ? `<main class="notice" aria-live="polite">
            <div class="monster pulse" aria-hidden="true">●ᴥ●</div>
            <h1>正在叫醒 TokenMonster…</h1>
          </main>`
        : "";

  return `<!doctype html>
<html lang="zh-Hant-TW">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; object-src 'none'; script-src 'nonce-tokenmonster-pet'; style-src 'nonce-tokenmonster-pet'">
    <title>TokenMonster</title>
    <style nonce="tokenmonster-pet">
      :root { color-scheme: light; font-family: Inter, ui-rounded, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: transparent; color: #322940; }
      .dragbar {
        -webkit-app-region: drag; align-items: center; background: rgba(45, 35, 57, .94);
        border-radius: 16px 16px 0 0; display: flex; height: 32px; justify-content: flex-end;
        padding: 3px 6px; user-select: none;
      }
      .brand { color: #fff7df; font-size: 11px; font-weight: 750; margin: 0 auto 0 8px; }
      .control {
        -webkit-app-region: no-drag; appearance: none; background: transparent; border: 0;
        border-radius: 8px; color: #fff7df; cursor: pointer; font: inherit; height: 26px;
        line-height: 1; min-width: 28px; padding: 0 7px;
      }
      .control:hover, .control:focus-visible { background: rgba(255, 255, 255, .16); outline: none; }
      .notice {
        align-items: center; background: linear-gradient(155deg, #fff8e9, #ecdff8); border: 1px solid rgba(68, 48, 84, .18);
        border-radius: 0 0 20px 20px; display: flex; flex-direction: column; height: calc(100% - 32px);
        justify-content: center; padding: 32px; text-align: center;
      }
      .monster { color: #715287; font-size: 48px; letter-spacing: -8px; margin: 0 8px 18px 0; }
      .pulse { animation: pulse 1.25s ease-in-out infinite alternate; }
      h1 { font-size: 19px; margin: 0 0 12px; }
      p { color: #655a6c; font-size: 13px; line-height: 1.6; margin: 0 0 20px; }
      .retry { background: #6f4e85; border: 0; border-radius: 999px; color: white; cursor: pointer; font-weight: 700; padding: 10px 18px; }
      @keyframes pulse { from { opacity: .45; transform: translateY(2px); } to { opacity: 1; transform: translateY(-2px); } }
    </style>
  </head>
  <body>
    <header class="dragbar">
      <span class="brand">TokenMonster</span>
      <button class="control" id="pin" type="button" title="${pinned ? "取消置頂" : "保持置頂"}" aria-label="${pinned ? "取消置頂" : "保持置頂"}">${pinned ? "●" : "○"}</button>
      <button class="control" id="dashboard" type="button" title="開啟完整 dashboard" aria-label="開啟完整 dashboard">↗</button>
      <button class="control" id="hide" type="button" title="隱藏到系統匣" aria-label="隱藏到系統匣">−</button>
    </header>
    ${content}
    <script nonce="tokenmonster-pet">
      const pin = document.getElementById("pin");
      pin.addEventListener("click", async () => {
        const pinned = await window.tokenMonsterPet.togglePin();
        pin.textContent = pinned ? "●" : "○";
        pin.title = pinned ? "取消置頂" : "保持置頂";
        pin.setAttribute("aria-label", pin.title);
      });
      document.getElementById("dashboard").addEventListener("click", () => window.tokenMonsterPet.openDashboard());
      document.getElementById("hide").addEventListener("click", () => window.tokenMonsterPet.hideWindow());
      document.getElementById("retry")?.addEventListener("click", () => { location.hash = "retry-" + Date.now(); });
    </script>
  </body>
</html>`;
}

export function petShellDataUrl(
  status: PetShellStatus,
  pinned: boolean
): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    petShellPage(status, pinned)
  )}`;
}
