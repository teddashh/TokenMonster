import type { UiLocale } from "./dto.js";

/**
 * The source-language phrase is the stable key. Keeping both locales in one
 * entry makes catalog parity structural: an English value cannot be omitted
 * without omitting the phrase itself.
 */
export const ENGLISH_UI_COPY = Object.freeze({
  語言: "Language",
  繁體中文: "Traditional Chinese",
  "語言偏好暫時無法儲存；這次視窗仍可切換，重新啟動後會回到繁體中文。":
    "The language preference cannot be saved right now. You can switch for this window; it returns to Traditional Chinese after restart.",
  "正在把語言偏好保存在這台裝置。":
    "Saving the language preference on this device.",
  "語言偏好暫時無法儲存；這次視窗會使用你的選擇。":
    "The language preference cannot be saved right now. This window will use your selection.",
  跳到主要內容: "Skip to main content",
  "TokenMonster 首頁": "TokenMonster home",
  正在啟動: "Starting",
  "點一下和 TokenMonster 字母 T 夥伴打招呼":
    "Tap to say hello to the TokenMonster letter T companion",
  正在換夥伴: "Switching companions",
  點一下和夥伴打招呼: "Tap to say hello",
  你的本機AI用量夥伴: "Your local AI usage companion",
  "你的本機 AI 用量夥伴": "Your local AI usage companion",
  先選一位姊妹陪你: "Choose a companion to join you",
  "先選一位姊妹陪你。": "Choose a companion to join you.",
  "本機用量服務正在準備，很快就好。":
    "The local usage service is getting ready.",
  顯示上次成功整理的資料: "Showing the last successfully prepared data",
  重新掃描: "Rescan",
  陪伴名單: "Companion roster",
  "連上角色名單後，你可以在這裡選擇夥伴。":
    "You can choose a companion here when the roster is ready.",
  修復角色選擇: "Repair character selection",
  開啟角色語音: "Enable character voice",
  關閉角色語音: "Disable character voice",
  點一下讓她們開口: "Tap to hear them speak",
  你的夥伴側寫: "Your companion profile",
  今日默契: "Today's connection",
  近28日夥伴特質: "Companion traits over 28 days",
  "近 28 日夥伴特質": "Companion traits over 28 days",
  "為什麼她今天是這個狀態？": "Why is she in this state today?",
  選擇陪伴角色: "Choose a companion",
  打開衣櫥: "Open wardrobe",
  收起衣櫥: "Close wardrobe",
  "挑一套已解鎖的造型；還在準備的款式會隨本機里程自然出現。":
    "Choose an unlocked look. More styles appear naturally with local milestones.",
  角色衣櫥: "Character wardrobe",
  我的夥伴卡: "My companion card",
  "本機用量整理完成後，就能把這次相遇存成圖片。":
    "When local usage is ready, you can save this meeting as an image.",
  分享時隱藏28日Token總量: "Hide the 28-day token total when sharing",
  "分享時隱藏 28 日 Token 總量": "Hide the 28-day token total when sharing",
  儲存PNG: "Save PNG",
  "儲存 PNG": "Save PNG",
  和她聊聊: "Chat with her",
  "正在確認本機 OpenAI 設定。": "Checking local OpenAI settings.",
  打開對話: "Open chat",
  收起對話: "Close chat",
  本機直連OpenAI: "Direct local connection to OpenAI",
  "本機直連 OpenAI": "Direct local connection to OpenAI",
  "訊息由這台裝置直接送到 OpenAI Responses API，TokenMonster 公開服務不會收到。請求使用":
    "Messages go directly from this device to the OpenAI Responses API. TokenMonster public services do not receive them. Requests use",
  "；仍適用 OpenAI 的資料保留政策。":
    "; OpenAI data-retention policies still apply.",
  "訊息由這台裝置直接送到 OpenAI Responses API，TokenMonster":
    "Messages go directly from this device to the OpenAI Responses API. TokenMonster",
  "公開服務不會收到。請求使用":
    "public services do not receive them. Requests use",
  "；仍適用": "; subject to",
  "OpenAI 的資料保留政策。": "OpenAI data-retention policies.",
  關閉並清除對話: "Close and clear chat",
  用作業系統安全儲存記住key: "Remember the key in secure OS storage",
  "用作業系統安全儲存記住 key": "Remember the key in secure OS storage",
  在本機設定: "Configure locally",
  目前這次對話: "Current conversation",
  "想對她說什麼？": "What would you like to say?",
  送出: "Send",
  刪除本機OpenAIkey: "Delete the local OpenAI key",
  "刪除本機 OpenAI key": "Delete the local OpenAI key",
  完整角色圖素材包: "Complete character art pack",
  "正在確認本機素材。": "Checking local character assets.",
  "啟用時會一次下載完整固定素材包。這個請求只取素材，不會傳送你的用量、目前角色、解鎖狀態或服裝選擇；之後可隨時移除下載的完整素材，內建四位元祖角色的基本服裝圖像與文字不受影響。":
    "Enabling downloads the complete fixed asset pack once. The request fetches assets only and sends no usage, selected character, unlock state, or outfit choice. You can remove the downloaded full assets at any time; the built-in basic-outfit art and text for the four original starter characters are unaffected.",
  啟用完整角色圖: "Enable full character art",
  取消啟用並清除下載素材: "Disable and remove downloaded assets",
  "這是受供應商產品啟發的虛構角色；TokenMonster 為獨立產品，未與該供應商合作、隸屬或獲其背書。":
    "These fictional characters are inspired by provider products. TokenMonster is independent and is not affiliated with or endorsed by those providers.",
  "這是受供應商產品啟發的虛構角色；TokenMonster":
    "These fictional characters are inspired by provider products. TokenMonster",
  "為獨立產品，未與該供應商合作、隸屬或獲其背書。":
    "is independent and is not affiliated with or endorsed by those providers.",
  用量與模型數據: "Usage and model data",
  Token用量: "Token usage",
  "Token 用量": "Token usage",
  你的近期足跡: "Your recent footprint",
  "今天（UTC）": "Today (UTC)",
  "近 7 天（UTC）": "Last 7 days (UTC)",
  "近 28 天（UTC）": "Last 28 days (UTC)",
  UTC每日趨勢: "Daily UTC trend",
  "UTC 每日趨勢": "Daily UTC trend",
  最近28個UTC日: "Last 28 UTC days",
  "最近 28 個 UTC 日": "Last 28 UTC days",
  "連上後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears after the service connects.",
  各家分析: "Provider analysis",
  供應商與模型用量: "Provider and model usage",
  分析期間: "Analysis period",
  "7 天": "7 days",
  "28 天": "28 days",
  "90 天": "90 days",
  "正在整理近 28 天的各家分析。":
    "Preparing provider analysis for the last 28 days.",
  這段期間還很安靜: "This period is still quiet",
  "有用量後，就會在這裡看到每一家與模型的分布。":
    "Provider and model distributions will appear here when usage is available.",
  "各家分析暫時載入不了。": "Provider analysis is temporarily unavailable.",
  "本機用量資料沒有遺失，可以再試一次。":
    "Your local usage data is safe. You can try again.",
  重新載入分析: "Reload analysis",
  每日家族分布: "Daily family distribution",
  供應商圖例: "Provider legend",
  "每日各供應商家族 token 用量（UTC）":
    "Daily token usage by provider family (UTC)",
  UTC日期: "UTC date",
  "UTC 日期": "UTC date",
  其他: "Other",
  家族占比: "Family share",
  Top10模型: "Top 10 models",
  "Top 10 模型": "Top 10 models",
  本機方案估算: "Local plan estimate",
  "剩餘額度（估算）": "Remaining quota (estimate)",
  "正在整理剩餘額度估算。": "Preparing the remaining quota estimate.",
  "以本機統計估算，非官方數據，僅供參考。":
    "Estimated from local statistics. Unofficial and for reference only.",
  "自願、匿名、預設關閉": "Voluntary, anonymous, and off by default",
  "分享匿名 Token 日彙總": "Share anonymous daily token aggregates",
  "正在確認匿名貢獻是否可用。":
    "Checking whether anonymous contribution is available.",
  "只會分享內容盲 UTC 日彙總；不含提示、回覆、原始碼、檔名、專案路徑、API key、OAuth token、事件、session 或每小時資料。TokenMonster 公開服務永遠不會收到供應商憑證。":
    "Only content-blind daily UTC aggregates are shared. They contain no prompts, responses, source code, filenames, project paths, API keys, OAuth tokens, events, sessions, or hourly data. TokenMonster public services never receive provider credentials.",
  預覽實際分享資料: "Preview the actual shared data",
  停止後續分享: "Stop future sharing",
  安全重試復原: "Retry recovery safely",
  刪除可識別貢獻資料: "Delete identifiable contribution data",
  分享預覽: "Contribution preview",
  "刪除會移除可識別的目前貢獻資料；已併入門檻統計的匿名歷史總量仍會保留。":
    "Deletion removes identifiable current contribution data. Anonymous historical totals already merged into thresholded statistics are retained.",
  "實際分享的 JSON 資料": "Actual JSON data to be shared",
  "我已檢查上方實際資料，並同意啟用匿名貢獻":
    "I reviewed the actual data above and agree to enable anonymous contribution",
  明確同意並啟用: "Explicitly agree and enable",
  "匿名貢獻無法啟用：這個啟動方式沒有經稽核的作業系統安全儲存。":
    "Anonymous contribution cannot be enabled because this launcher has no audited secure OS storage.",
  "上次操作結果不明；可以安全重試復原，不會建立新憑證。":
    "The last operation has an uncertain result. Recovery can be retried safely without creating new credentials.",
  "上次操作仍需安全完成本機憑證清理；復原不會建立新憑證。":
    "The previous operation still needs secure local credential cleanup. Recovery does not create new credentials.",
  "匿名貢獻目前關閉（預設）。":
    "Anonymous contribution is currently off by default.",
  "匿名貢獻已啟用；只會背景分享內容盲 UTC 日彙總。":
    "Anonymous contribution is enabled. Only content-blind daily UTC aggregates are shared in the background.",
  "後續匿名貢獻已停止；可識別目前資料仍可刪除。":
    "Future anonymous contribution has stopped. Identifiable current data can still be deleted.",
  "刪除要求處理中；匿名歷史總量仍會保留。":
    "The deletion request is being processed. Anonymous historical totals are retained.",
  "可識別目前貢獻資料已刪除；匿名歷史總量仍會保留。":
    "Identifiable current contribution data has been deleted. Anonymous historical totals are retained.",
  "刪除狀態失敗；後續上傳仍停用，請聯絡支援。":
    "Deletion failed. Future uploads remain disabled; contact support.",
  "匿名貢獻目前不可用；本機統計仍正常運作。":
    "Anonymous contribution is unavailable. Local statistics continue to work.",
  "正在處理匿名貢獻設定。": "Updating anonymous contribution settings.",
  "匿名貢獻控制暫時無法完成；本機統計不受影響。":
    "The anonymous contribution control could not finish. Local statistics are unaffected.",
  再按一次確認刪除可識別貢獻資料:
    "Press again to confirm deletion of identifiable contribution data",
  "匿名貢獻狀態暫時無法讀取；本機統計仍正常運作。":
    "Anonymous contribution status cannot be read right now. Local statistics continue to work.",
  只在這台裝置: "Only on this device",
  夥伴每日提醒: "Daily companion reminder",
  "正在確認系統通知。": "Checking system notifications.",
  "通知只含固定文字，不含提示、回覆、檔名或專案路徑；設定與排程都留在這台裝置。":
    "Notifications use fixed text and contain no prompts, responses, filenames, or project paths. Settings and schedules stay on this device.",
  先測試系統通知: "Test system notification first",
  "測試不會開啟每日排程；提醒預設保持關閉。":
    "A test does not enable the daily schedule. Reminders remain off by default.",
  每天提醒我回來看看夥伴: "Remind me daily to visit my companion",
  每日摘要時間: "Daily summary time",
  "安靜時段（開始與結束相同代表停用）":
    "Quiet hours (matching start and end means off)",
  開始: "Start",
  結束: "End",
  儲存提醒設定: "Save reminder settings",
  本機應用程式: "Local application",
  TokenMonster更新: "TokenMonster updates",
  "TokenMonster 更新": "TokenMonster updates",
  "正在讀取這台裝置的更新設定。": "Reading update settings from this device.",
  "自動檢查預設關閉。只有開啟它或按下手動檢查時，TokenMonster 才會連到程式內固定的官方 Windows 更新來源；畫面不能指定網址。":
    "Automatic checks are off by default. TokenMonster connects to its fixed official Windows update source only when you enable them or check manually. The UI cannot choose a URL.",
  "自動檢查預設關閉。只有開啟它或按下手動檢查時，TokenMonster":
    "Automatic checks are off by default. TokenMonster",
  "才會連到程式內固定的官方 Windows 更新來源；畫面不能指定網址。":
    "connects to its fixed official Windows update source only when enabled or checked manually. The UI cannot choose a URL.",
  定期自動檢查新版: "Check for updates automatically",
  手動檢查更新: "Check for updates",
  重新啟動並安裝: "Restart and install",

  正在處理: "Working",
  "正在處理…": "Working…",
  "暫時無法讀取這台裝置的提醒設定。":
    "Reminder settings are temporarily unavailable on this device.",
  "正在把設定保存在這台裝置。": "Saving settings on this device.",
  "提醒設定已儲存。": "Reminder settings saved.",
  "每日提醒已關閉。": "Daily reminders are off.",
  "提醒設定已在另一個視窗更新；已重新載入最新設定，請確認後再儲存。":
    "Reminder settings changed in another window. The latest settings were reloaded; review them before saving.",
  "本機提醒設定暫時無法儲存。":
    "Local reminder settings cannot be saved right now.",
  "提醒服務正在結束，這次沒有儲存。":
    "The reminder service is shutting down, so this change was not saved.",
  "設定格式不正確，這次沒有儲存。":
    "The settings are invalid and were not saved.",
  "提醒設定沒有儲存；請稍後再試。":
    "Reminder settings were not saved. Try again later.",
  "正在送出一則本機測試通知。": "Sending a local test notification.",
  "測試通知已交給作業系統。":
    "The test notification was handed to the operating system.",
  "這個系統目前不支援通知。":
    "This system does not currently support notifications.",
  "提醒服務正在結束，沒有送出測試。":
    "The reminder service is shutting down, so the test was not sent.",
  "作業系統沒有顯示這次測試通知。":
    "The operating system did not show the test notification.",
  "測試通知沒有送出；請稍後再試。":
    "The test notification was not sent. Try again later.",
  "提醒設定暫時無法使用；每日提醒保持關閉。":
    "Reminder settings are unavailable; daily reminders remain off.",
  "設定已保存在本機，但這個系統目前不支援通知，因此不會顯示提醒。":
    "Settings are saved locally, but this system does not support notifications, so reminders will not appear.",
  "這個系統目前不支援通知；每日提醒仍保持關閉。":
    "This system does not support notifications; daily reminders remain off.",
  "每日提醒目前關閉；設定只會保存在這台裝置。":
    "Daily reminders are off; settings stay only on this device.",
  "設定已保存在本機，但排程暫時沒有啟動；重新啟動 TokenMonster 後會再嘗試。":
    "Settings are saved locally, but scheduling did not start. TokenMonster will try again after restart.",
  安靜時段已停用: "Quiet hours are off",

  "正在檢查…": "Checking…",
  "正在下載…": "Downloading…",
  "正在準備重新啟動…": "Preparing to restart…",
  現在重新啟動並安裝: "Restart and install now",
  "暫時無法讀取這台裝置的更新狀態。":
    "Update status is temporarily unavailable on this device.",
  "正在把更新偏好保存在這台裝置。":
    "Saving the update preference on this device.",
  "自動檢查已開啟；第一次檢查會稍後開始。":
    "Automatic checks are on; the first check will begin shortly.",
  "之後的自動檢查已關閉；目前已開始的下載仍會完成。":
    "Future automatic checks are off; a download already in progress will finish.",
  "自動檢查已關閉。": "Automatic checks are off.",
  "更新偏好已在另一個視窗變更；已重新載入最新設定。":
    "The update preference changed in another window. The latest setting was reloaded.",
  "本機更新偏好暫時無法儲存；自動檢查保持關閉。":
    "The local update preference cannot be saved; automatic checks remain off.",
  "更新服務正在結束，這次沒有儲存。":
    "The update service is shutting down, so this change was not saved.",
  "更新偏好格式不正確，這次沒有儲存。":
    "The update preference is invalid and was not saved.",
  "更新偏好沒有儲存；請稍後再試。":
    "The update preference was not saved. Try again later.",
  "這次手動檢查由你明確啟動。":
    "You explicitly started this manual update check.",
  "更新檢查已開始；若有新版會自動下載。":
    "The update check started. A new version will download automatically.",
  "已有一個更新檢查或下載正在進行。":
    "An update check or download is already in progress.",
  "這個平台目前不支援應用程式內更新。":
    "In-app updates are not supported on this platform.",
  "更新服務正在結束。": "The update service is shutting down.",
  "這次無法開始更新檢查；稍後可再試。":
    "The update check could not start. Try again later.",
  "正在安全關閉本機服務，接著會重新啟動並安裝。":
    "Safely closing local services before restarting to install.",
  "正在重新啟動並安裝新版。": "Restarting to install the update.",
  "安裝程序已經開始。": "Installation has already started.",
  "新版尚未準備完成，這次不會重新啟動。":
    "The update is not ready, so TokenMonster will not restart.",
  "無法開始安裝；TokenMonster 會繼續保持開啟。":
    "Installation could not start. TokenMonster will remain open.",
  "正在安全地檢查新版 TokenMonster。":
    "Safely checking for a new TokenMonster version.",
  "已找到新版，正在背景下載並驗證安裝檔。":
    "A new version was found. Downloading and verifying it in the background.",
  新版: "the new version",
  "更新資訊未通過版本驗證，這次不會安裝。":
    "Update metadata failed version validation and will not be installed.",
  "這次更新檢查沒有完成；稍後可再手動重試。":
    "The update check did not finish. You can retry manually later.",
  "本機更新偏好暫時無法使用；自動檢查保持關閉。":
    "The local update preference is unavailable; automatic checks remain off.",
  "自動檢查已開啟；TokenMonster 會定期查看固定的官方更新來源。":
    "Automatic checks are on. TokenMonster will periodically check its fixed official source.",
  "自動檢查目前關閉；只有按下手動檢查才會連線查看更新。":
    "Automatic checks are off. TokenMonster connects only when you check manually.",

  再按一次確認移除: "Press again to confirm removal",
  "正在取得並驗證完整素材；完成前仍可使用內建四位元祖角色的基本服裝圖像與文字。":
    "Fetching and verifying the complete asset pack. The built-in basic-outfit art and text for the four original starter characters remain available until it is ready.",
  "正在下載完整素材包…": "Downloading the complete asset pack…",
  "移除只會刪除下載的完整素材；內建四位元祖角色的基本服裝圖像與文字會保留。若確定，請再按一次。":
    "Removal deletes only the downloaded full assets. The built-in basic-outfit art and text for the four original starter characters remain. Press again to confirm.",
  "完整素材已驗證並保存在本機；角色圖現在可以離線顯示。":
    "The complete asset pack is verified and stored locally. Character art now works offline.",
  重新下載完整素材: "Download the complete assets again",
  再次清除殘留素材: "Remove remaining assets again",
  "取消啟用只會清除已下載的完整素材；內建四位元祖角色的基本服裝圖像與文字會保留。若確定，請再按一次。":
    "Disabling removes only the downloaded full assets. The built-in basic-outfit art and text for the four original starter characters remain. Press again to confirm.",
  "下載的完整素材已停用，內建四位元祖角色的基本服裝圖像與文字仍可使用，但本機停用設定沒有保存；請在重啟前再試一次。":
    "Downloaded full assets are disabled and the built-in basic-outfit art and text for the four original starter characters remain available, but the local disabled setting was not saved. Try again before restarting.",
  "你曾同意啟用，但本機完整素材不完整；不會自動重試。你可以重新取得完整包，或取消啟用並清除下載素材；內建四位元祖角色的基本服裝圖像與文字仍可使用。":
    "You previously enabled the pack, but the local full assets are incomplete. It will not retry automatically. Download the full pack again or disable and remove the downloaded assets; the built-in basic-outfit art and text for the four original starter characters remain available.",
  "內建四位元祖角色的基本服裝圖像與文字仍可使用，但部分下載素材暫時無法移除。關閉正在使用圖片的程式後，可在這裡再次清除。":
    "The built-in basic-outfit art and text for the four original starter characters remain available, but some downloaded assets could not be removed. Close programs using the images and try again here.",
  "這次下載或驗證沒有完成；內建四位元祖角色的基本服裝圖像與文字仍可使用，可以稍後再試。":
    "Download or verification did not finish. The built-in basic-outfit art and text for the four original starter characters remain available; try again later.",
  "本機完整素材空間暫時無法使用；內建四位元祖角色的基本服裝圖像與文字仍可使用。":
    "Local full-asset storage is unavailable. The built-in basic-outfit art and text for the four original starter characters remain available.",
  "本機啟用設定暫時無法保存；內建四位元祖角色的基本服裝圖像與文字仍可使用。":
    "The local enable setting could not be saved. The built-in basic-outfit art and text for the four original starter characters remain available.",
  "目前使用內建四位元祖角色的基本服裝圖像與文字；只有你按下啟用後才會下載完整素材。":
    "The built-in basic-outfit art and text for the four original starter characters are active. The full assets download only after you enable them.",
  "沒有確認這次素材設定已套用；已顯示目前狀態，請再試一次。":
    "The asset setting was not confirmed. The current state is shown; try again.",

  "正在製作…": "Creating…",
  "正在歡迎新夥伴；慶祝結束後再儲存夥伴卡。":
    "Welcoming a new companion. Save the card after the celebration.",
  "正在套用你的角色選擇；完成後再儲存夥伴卡。":
    "Applying your character choice. Save the card when it finishes.",
  "正在安全檢查角色進度；完成後再儲存夥伴卡。":
    "Safely checking character progress. Save the card when it finishes.",
  "先選一位夥伴，才能把這次相遇存成圖片。":
    "Choose a companion before saving this meeting as an image.",
  "正在整理今天的默契；完成後就能存成圖片。":
    "Preparing today's connection. The card will be available when it finishes.",
  "本機服務恢復並更新今日默契後，就能存成圖片。":
    "The card will be available after the local service recovers and updates today's connection.",
  "今日默契暫時沒更新；我會在一分鐘後自動再試。":
    "Today's connection has not updated. I will retry automatically in one minute.",
  "今日默契已超過十五分鐘，更新完成後就能存成圖片。":
    "Today's connection is over fifteen minutes old. The card will be available after it updates.",
  "正在等今天最新的默契側寫，完成後就能存成圖片。":
    "Waiting for today's latest connection profile before saving the card.",
  "角色、今日默契與收藏會留在圖片上；28 日 Token 總量會隱藏。":
    "The character, today's connection, and collection stay on the image; the 28-day token total is hidden.",
  "角色、今日默契、收藏與近 28 日足跡會直接在本機繪成圖片。":
    "The character, today's connection, collection, and 28-day footprint are drawn locally into the image.",
  "正在本機繪製你的夥伴卡…": "Drawing your companion card locally…",
  "角色或今日默契已更新，請再儲存一次夥伴卡。":
    "The character or today's connection changed. Save the companion card again.",
  "已存檔；圖片只有角色、今日默契、收藏與彙總用量，不含對話內容。":
    "Saved. The image contains only the character, today's connection, collection, and aggregate usage—not chat content.",
  "已取消儲存；夥伴卡沒有寫入檔案。":
    "Save cancelled. No companion card was written.",
  "同名夥伴卡已存在；請先移動舊檔或換個位置再試。":
    "A companion card with that name already exists. Move it or choose another location.",
  "已交給瀏覽器下載；是否完成請查看瀏覽器下載清單。":
    "Sent to the browser. Check the downloads list for completion.",
  "這次沒有存成圖片，請稍後再試；角色與用量仍保留在本機。":
    "The image was not saved. Try again later; character and usage data remain local.",

  "OpenAI key 已由作業系統安全儲存；對話只留在這個畫面。":
    "The OpenAI key is in secure OS storage. This chat stays only on this screen.",
  "OpenAI key 只留在這次執行的記憶體；關閉 TokenMonster 就會清除。":
    "The OpenAI key stays in memory for this run and is cleared when TokenMonster closes.",
  "可用自己的 OpenAI key 即時對話；沒有 key 時仍使用本機固定台詞。":
    "Use your own OpenAI key for live chat. Local fixed lines still work without a key.",
  "可用自己的 OpenAI key 即時對話；這個環境只會暫存在記憶體。":
    "Use your own OpenAI key for live chat. This environment stores it in memory only.",
  "正在本機設定 OpenAI key…": "Configuring the OpenAI key locally…",
  "已設定完成。key 不會送到 TokenMonster 公開服務。":
    "Configured. The key is never sent to TokenMonster public services.",
  "這把 key 的格式不完整，請重新貼上。":
    "The key format is incomplete. Paste it again.",
  "這次沒有保存 key；本機角色與固定台詞仍可使用。":
    "The key was not saved. Local characters and fixed lines still work.",
  "正在刪除本機 OpenAI key…": "Deleting the local OpenAI key…",
  "本機 key 與這次對話都已清除。":
    "The local key and this chat have been cleared.",
  "這次沒有刪除成功；請再試一次。": "Deletion failed. Try again.",
  "她正在透過 OpenAI 回覆…": "She is replying through OpenAI…",
  "即時對話暫時沒接上；角色與本機固定台詞都不受影響。":
    "Live chat is temporarily unavailable. Characters and local fixed lines are unaffected.",
  "OpenAI API key 已不在本機，重新設定後才能繼續聊。":
    "The OpenAI API key is no longer local. Configure it again to continue.",
  "OpenAI 沒有接受這把 key；請清除後重新設定。":
    "OpenAI did not accept this key. Clear it and configure it again.",
  "OpenAI 現在很忙，稍後再聊；本機固定台詞仍可使用。":
    "OpenAI is busy. Try again later; local fixed lines still work.",
  "上一句還在回覆，等她說完再送下一句。":
    "A reply is still in progress. Wait before sending another message.",
  "這次對話已取消，內容沒有寫進 TokenMonster 儲存。":
    "This request was cancelled and was not written to TokenMonster storage.",
  "OpenAI 的回覆這次無法顯示；先讓本機台詞陪你。":
    "The OpenAI reply cannot be shown. Local fixed lines remain available.",

  今日默契暫時未更新: "Today's connection is temporarily out of date",
  本機服務恢復後自動更新:
    "Updates automatically when the local service recovers",
  正在更新: "Updating",
  一分鐘後自動再試: "Retries automatically in one minute",
  "角色、收藏與本機用量仍可正常使用；側寫恢復後才會開放夥伴卡。":
    "Characters, collection, and local usage still work. The companion card returns when the profile recovers.",
  等待本機側寫: "Waiting for the local profile",
  自然認識中: "Learning naturally",
  "這不是今天最新的側寫；更新成功前不會放進夥伴卡。":
    "This is not today's latest profile and will not be included in the companion card until updated.",

  正在換夥伴完成後再打招呼: "Wait until the companion switch finishes",
  "正在換夥伴，完成後再打招呼":
    "Wait until the companion switch finishes before saying hello",
  "正在確認你選的夥伴；完成前先不接受另一個角色選擇。":
    "Confirming your companion choice. Another choice is unavailable until it finishes.",
  "這次沒有換成功，原本的夥伴會繼續陪你。":
    "The switch did not finish. Your previous companion will stay with you.",
  "請保留這個視窗。若其他或舊版 TokenMonster 仍在執行，請先從其系統匣／選單列選「結束 TokenMonster」。確認只剩這個視窗後再繼續；修復只會移除舊版留下的鎖，不會重設角色進度。":
    "Keep this window open. If another or older TokenMonster is running, choose Quit TokenMonster from its tray or menu. Continue when only this window remains; repair removes only the old lock and does not reset character progress.",
  依本機用量推薦: "Recommended from local usage",
  "正在歡迎新夥伴；慶祝結束後就能繼續選擇。":
    "Welcoming a new companion. You can choose again after the celebration.",
  "安全檢查完成後就能繼續選擇。":
    "You can choose again after the safety check.",
  "正在套用角色或服裝；完成後就能繼續選擇。":
    "Applying a character or outfit. You can choose again when it finishes.",
  "日常使用會自然記下新的相遇。":
    "Everyday usage records new meetings naturally.",
  下一位夥伴的本機相遇進度: "Local meeting progress for the next companion",
  "正在換上你選的服裝；完成前先不接受其他角色或服裝選擇。":
    "Applying your selected outfit. Other character and outfit choices are unavailable until it finishes.",
  "這套服裝暫時沒有換上，先保留現在的樣子。":
    "This outfit was not applied. The current look remains.",
  歡迎新夥伴中: "Welcoming a new companion",
  正在套用角色或服裝: "Applying character or outfit",
  正在檢查角色進度: "Checking character progress",
  "慶祝結束後就能繼續換衣服。": "You can change outfits after the celebration.",
  "角色選擇完成後就能繼續換衣服。":
    "You can change outfits after the character choice finishes.",
  "安全檢查完成後就能繼續換衣服。":
    "You can change outfits after the safety check.",
  "隨本機使用里程自然解鎖，不需要額外消耗 token。":
    "Unlocks naturally through local usage milestones; no extra token use is needed.",
  解鎖進度: "Unlock progress",
  "正在歡迎新夥伴；慶祝結束後就能繼續打招呼、換衣與儲存夥伴卡。":
    "Welcoming a new companion. Chat, outfits, and companion cards return after the celebration.",
  "先從名單選一位 TokenMonster 夥伴":
    "Choose a TokenMonster companion from the roster",
  先從名單選一位夥伴: "Choose a companion from the roster",
  "四位都有不同個性，抽一張卡讓緣分決定；想自己挑或之後換人都可以。":
    "Each has a different personality. Draw a card and let fate decide; picking yourself or switching later is fine too.",
  第一位姊妹要降生了: "Your first sister is about to arrive",
  "抽一張卡，看看是誰來到你身邊": "Draw a card and see who comes to you",
  抽卡: "Draw",
  想自己挑也可以: "Prefer to pick yourself? That works too",
  回到抽卡: "Back to the card draw",
  抽出你的第一位姊妹: "Draw your first sister",
  "正在歡迎新夥伴；慶祝結束後就能抽卡。":
    "Welcoming a new companion. You can draw after the celebration.",
  "安全檢查完成後就能抽卡。": "You can draw after the safety check completes.",
  "正在套用角色或服裝；完成後就能抽卡。":
    "Applying a character or outfit. You can draw when it finishes.",
  "這是你選的夥伴；想換人或換衣服都可以慢慢來。":
    "This is your chosen companion. Switch companions or outfits whenever you like.",
  "先由她陪你；你隨時可以換，不需要多用 token。":
    "She will join you for now. You can switch anytime without using extra tokens.",
  正在歡迎新夥伴稍後再打招呼: "Welcoming a new companion; say hello shortly",
  "正在歡迎新夥伴，稍後再打招呼":
    "Welcoming a new companion; say hello shortly",
  "夥伴正在準備中，馬上就好": "Your companion is getting ready",
  正在歡迎新解鎖的TokenMonster夥伴:
    "Welcoming a newly unlocked TokenMonster companion",
  "正在歡迎新解鎖的 TokenMonster 夥伴":
    "Welcoming a newly unlocked TokenMonster companion",
  "我整理了一個本機用量推薦；這只是參考，第一位夥伴仍由你親自選。":
    "I prepared a recommendation from local usage. It is only a suggestion; you still choose your first companion.",
  "近 28 天有兩位並列，這次由你選；之後也能隨時換。":
    "Two companions are tied over 28 days. Choose either now and switch anytime.",
  "目前沒有足夠的 provider 分項，由你選；不需要多用 token。":
    "There is not enough provider detail yet. Choose freely; no extra token use is needed.",

  正在同步: "Syncing",
  "我正在掃描支援的本機用量來源，先不把空白當成零。":
    "Scanning supported local usage sources without treating missing data as zero.",
  "我正在重新掃描；先保留上次整理好的用量。":
    "Rescanning while keeping the last prepared usage visible.",
  正在掃描: "Scanning",
  "掃描完成後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears when scanning finishes.",
  掃描未完成: "Scan incomplete",
  "第一次掃描沒有完成。可以再試一次，我也會繼續留在這裡。":
    "The first scan did not finish. Try again; I will stay here.",
  再試一次: "Try again",
  "重新掃描成功後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears after a successful rescan.",
  暫時中斷: "Temporarily disconnected",
  "本機用量服務暫時沒回應，我會稍後再試。":
    "The local usage service is not responding. I will try again later.",
  立即重試: "Retry now",
  "連線恢復後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears when the connection recovers.",
  需要更新: "Update required",
  "目前版本無法讀取用量。請重新啟動或更新 TokenMonster，再重新檢查。":
    "This version cannot read usage. Restart or update TokenMonster, then check again.",
  重新檢查: "Check again",
  "更新完成後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears after the update.",
  資料稍舊: "Data is slightly stale",
  "這是上次成功整理的用量；這次掃描沒完成，你可以再試一次。":
    "This is the last successfully prepared usage. The latest scan did not finish; try again.",
  掃描完成: "Scan complete",
  "還沒找到支援的本機用量來源；這不是安靜的一天，你可以隨時重新掃描。":
    "No supported local usage source was found. This is not counted as a quiet day; rescan anytime.",
  已連線: "Connected",
  "今天（UTC）還很安靜，我會在這裡陪你。":
    "Today (UTC) is still quiet. I will stay with you.",
  "今天（UTC）的用量已經整理好了。": "Today's (UTC) usage is ready.",
  "啟動完成後會顯示 UTC 每日趨勢。":
    "The daily UTC trend appears after startup.",
  "目前還沒有 UTC 每日用量紀錄。": "There are no daily UTC usage records yet.",

  未設定: "Not set",
  正在儲存: "Saving",
  "正在儲存…": "Saving…",
  "方案已更新。": "Plan updated.",
  "方案未更新，請再試一次。": "The plan was not updated. Try again.",
  已超過估算額度: "Estimated quota exceeded",
  "暫時未更新，顯示上次成功的額度估算。":
    "Not updated yet; showing the last successful quota estimate.",
  "剩餘額度估算暫時載入不了。":
    "The remaining quota estimate is temporarily unavailable.",
  "目前沒有可列出的模型明細。": "No model details are available.",
  Gemini免費版: "Gemini Free",
  "Gemini 免費版": "Gemini Free",
  "選一位姊妹開始陪你。": "Choose a companion to join you.",
  "TokenMonster 字母 T 夥伴": "TokenMonster letter T companion",
  "舊版進度鎖擋住了角色選擇。請保留這個視窗，並從其他舊版的系統匣／選單列選「結束 TokenMonster」，再安全修復；你的角色進度不會被重設。":
    "An old progress lock is blocking character selection. Keep this window open, quit other older TokenMonster versions from their tray or menu, then repair safely. Character progress will not be reset.",
  "正在安全檢查…": "Checking safely…",
  "正在確認舊版進度鎖；完成前不會變更角色或進度。":
    "Checking the old progress lock. No character or progress changes occur before it finishes.",
  結束舊版後再檢查: "Quit the old version, then check again",
  "另一個 TokenMonster 仍在使用角色進度。請保留這個視窗，從其他版本的系統匣／選單列選「結束 TokenMonster」後，再按一次檢查。":
    "Another TokenMonster is using character progress. Keep this window open, quit the other version from its tray or menu, then check again.",
  "角色進度已可安全寫入，沒有被重設。請再選一次你想要的夥伴。":
    "Character progress is writable and was not reset. Choose your companion again.",
  重新檢查角色選擇: "Check character selection again",
  "修復檢查沒有完成，角色進度沒有變動。保留這個視窗，並從其他版本的系統匣／選單列結束 TokenMonster 後，可以再試一次。":
    "The repair check did not finish and character progress did not change. Keep this window open, quit other TokenMonster versions from their tray or menu, then try again.",
  "她會照自己的步調準備好，不需要為了解鎖多用 token。":
    "She will get ready at her own pace. No extra token use is needed to unlock her.",
  科技: "Technology",
  金融: "Finance",
  政治: "Politics",
  教育: "Education",
  健康: "Health",
  環境: "Environment",
  法律: "Law",
  關係: "Relationships",
  家庭: "Family",
  職場: "Workplace",
  科學: "Science",
  文化: "Culture",
  運動: "Sports",
  美食: "Food",
  旅行: "Travel",
  心理: "Psychology",
  哲學: "Philosophy",
  國際: "International",
  媒體: "Media",
  節慶: "Festivals",
  CLI專注型: "CLI focused",
  "CLI 專注型": "CLI focused",
  "她發現你常在命令列裡，把想法一步步變成行動。":
    "She notices that you often turn ideas into action at the command line.",
  工具專注型: "Tool focused",
  "你近期常回到熟悉的工具，使用節奏很一致。":
    "You often return to familiar tools with a consistent rhythm.",
  多工具切換型: "Multi-tool",
  "你會在不同工具之間自然切換，找到適合當下的方式。":
    "You move naturally among tools and choose what fits the moment.",
  Cache節奏型: "Cache rhythm",
  "Cache 節奏型": "Cache rhythm",
  "你的近期用量裡，快取的使用節奏相對明顯。":
    "Cache usage has a noticeable rhythm in your recent activity.",
  輸出導向型: "Output focused",
  "你的近期互動較常讓夥伴把回答完整展開。":
    "Your recent interactions more often invite complete, expanded answers.",
  深夜節奏型: "Night rhythm",
  "有足夠的本機時段資料顯示，你較常在夜間出現。":
    "Sufficient local timing data shows that you appear more often at night.",
  認識中: "Learning",
  "她還在安靜認識你的日常節奏。":
    "She is quietly learning your everyday rhythm.",
  最近節奏未確認: "Unknown rhythm",
  "最近一個完整 UTC 日的資料還不可用，所以她不會替你猜測。":
    "The last complete UTC day is unavailable, so she will not guess your rhythm.",
  最近在休息: "Resting",
  "最近一個完整 UTC 日沒有記錄到使用；休息也是很自然的節奏。":
    "No usage was recorded on the last complete UTC day; rest is a natural rhythm too.",
  輕聲陪伴: "Quiet company",
  "最近一個完整 UTC 日比你自己的近期節奏安靜一些。":
    "The last complete UTC day was quieter than your recent rhythm.",
  穩穩同行: "Steady company",
  "最近一個完整 UTC 日接近你自己的近期使用節奏。":
    "The last complete UTC day was close to your recent rhythm.",
  活力同行: "Lively company",
  "最近一個完整 UTC 日比你自己的近期使用節奏活躍一些。":
    "The last complete UTC day was more active than your recent rhythm.",
  安靜: "Quiet",
  柔和: "Gentle",
  穩定: "Steady",
  活躍: "Active",
  還在認識你: "Still learning",
  "資料會隨平常使用自然補齊，不需要刻意增加用量。":
    "Data fills in through normal use; there is no need to increase usage deliberately.",
  初次側寫完成: "First profile",
  "她第一次整理出你的近期使用節奏。":
    "She has prepared your recent usage rhythm for the first time.",
  側寫逐漸清楚: "Profile clearer",
  "可用日資料已足以讓近期輪廓成形。":
    "Enough available daily data now exists for a recent profile.",
  節奏有新變化: "Rhythm changed",
  "近期自然使用的樣子改變了，側寫也跟著調整。":
    "Your recent natural usage changed, so the profile adjusted with it.",
  本週側寫更新: "Weekly update",
  "她完成了這一週的例行整理。": "She completed this week's routine review.",
  近期節奏穩定: "Rhythm steady",
  "這次整理沒有發現需要改寫的主要特質。":
    "This review found no major trait that needed to change.",
  "可用日期還不足，夥伴先保持「認識中」。":
    "There are not enough available days, so the companion remains in learning mode.",
  "近期資料還無法證明穩定特質，夥伴會保持「認識中」而不替你猜測。":
    "Recent data does not establish stable traits, so the companion keeps learning instead of guessing.",
  "已有足夠的本機日資料，可以整理出目前的使用節奏。":
    "There is enough local daily data to describe the current usage rhythm.",
  "同一個 28 天區間沿用已確認的側寫，避免重整時跳動。":
    "The confirmed profile is retained within the same 28-day window to avoid refresh jumps.",
  "近期證據暫時不足；夥伴最多保留七個自然日的既有側寫，之後會回到認識中。":
    "Recent evidence is temporarily insufficient. The prior profile is retained for at most seven calendar days before returning to learning mode.",
  "新的趨勢會分次反映，避免一天內讓側寫大幅跳動。":
    "New trends are applied gradually to avoid large profile changes in one day.",
  "近 28 天的工具使用較集中在命令列介面。":
    "Tool usage over 28 days is concentrated in command-line interfaces.",
  "近 28 天的使用較集中在一種工具介面。":
    "Usage over 28 days is concentrated in one tool interface.",
  "近 28 天自然地使用了多種工具介面。":
    "Several tool interfaces appeared naturally over 28 days.",
  "本機資料顯示，快取用量在已觀察區間中較明顯。":
    "Local data shows a noticeable cache share in the observed period.",
  "本機資料顯示，輸出在已觀察用量中的占比較高。":
    "Local data shows a higher output share in observed usage.",
  "有足夠的本機時段資料顯示，使用較常落在夜間。":
    "Sufficient local timing data shows usage occurs more often at night.",
  "同一個資料區間先維持已確認的特質，避免重整時跳動。":
    "Confirmed traits stay within the same data window to avoid refresh jumps.",
  "目前先短暫保留已確認的特質；證據沒有恢復時不會一直沿用。":
    "Confirmed traits are retained briefly and will not persist if evidence does not recover.",
  "特質變化會分次反映，讓夥伴的個性保持連續。":
    "Trait changes are applied gradually to keep the companion's personality continuous.",
  "資料仍在自然累積，今天先以認識中的狀態陪你。":
    "Data is accumulating naturally, so the companion stays in learning mode today.",
  "最近一個完整 UTC 日的本機資料不可用，所以不推測你的節奏。":
    "Local data for the last complete UTC day is unavailable, so no rhythm is inferred.",
  "最近一個完整 UTC 日沒有記錄到使用；休息也很正常。":
    "No usage was recorded on the last complete UTC day; rest is normal too.",
  "最近一個完整 UTC 日的使用比你自己的近期節奏安靜。":
    "Usage on the last complete UTC day was quieter than your recent rhythm.",
  "最近一個完整 UTC 日的使用接近你自己的近期節奏。":
    "Usage on the last complete UTC day was close to your recent rhythm.",
  "最近一個完整 UTC 日的使用比你自己的近期節奏活躍。":
    "Usage on the last complete UTC day was more active than your recent rhythm.",
  "夥伴會等待自然累積的可用日資料，不需要特別做什麼。":
    "The companion waits for available daily data to accumulate naturally; no special action is needed.",
  "這是她第一次完成你的近期側寫。":
    "This is the first completed version of your recent profile.",
  "可用資料已足以讓側寫從認識中成形。":
    "Enough data is available for the profile to take shape.",
  "近期使用節奏改變，側寫也跟著調整。":
    "The recent usage rhythm changed, so the profile adjusted.",
  "這次是七個自然日後的例行側寫整理。":
    "This is the routine profile review after seven calendar days.",
  "這次整理後，主要特質維持不變。":
    "The main traits remain unchanged after this review.",
  "夥伴還在從自然使用中認識你的節奏；照平常方式使用就好，不需要刻意增加用量。":
    "The companion is learning your rhythm from natural use. Continue normally; no deliberate increase is needed.",
  "近期可用證據暫時不足；既有側寫只會短暫保留，沒有恢復時會自動回到認識中。":
    "Recent evidence is temporarily insufficient. The existing profile is retained briefly, then returns to learning mode if evidence does not recover.",
  "夥伴已看見新的節奏，但會分次調整側寫，避免一天內突然改變。":
    "The companion sees a new rhythm but adjusts the profile gradually to avoid sudden daily changes.",
  "這是依最近 28 個 UTC 日的可用本機資料整理出的使用節奏，不是效率或能力評分。":
    "This usage rhythm is based on available local data from 28 UTC days. It is not a score of efficiency or ability.",
  最新本機側寫: "Latest local profile",
  最近一次可用側寫: "Most recent available profile",
  "依目前可用的本機日資料整理。":
    "Based on currently available local daily data.",
  "本機資料暫時無法更新；恢復後會自動重算。":
    "Local data cannot update right now and will recalculate after recovery.",
  "依最近 28 個 UTC 日的可用本機資料整理。":
    "Based on available local data from the last 28 UTC days.",
  夥伴側寫: "Companion profile",
  側寫已成形: "Profile established",
  "只根據本機可用日的無內容彙總估算；短期狀態只比較完整 UTC 日，缺少的日期不會被當成零用量。":
    "Estimated only from content-blind aggregates on available local days. Short-term state compares complete UTC days; missing dates are not treated as zero usage.",
  由你保留: "Kept private",
  近28日總量未顯示: "28-day total hidden",
  "近 28 日總量未顯示": "28-day total hidden",
  tokens本機用量: "tokens · local usage",
  "tokens・本機用量": "tokens · local usage",
  我的本機AI夥伴摘要: "My local AI companion summary",
  "我的本機 AI 夥伴摘要": "My local AI companion summary",
  陪你一起看見每一次累積: "See every step add up together",
  夥伴收藏: "Companion collection",
  位已相遇夥伴: "companions met",
  我的夥伴側寫: "My companion profile",
  "每一次相遇，都只留在你的裝置裡。":
    "Every meeting stays only on your device.",
  純本機個人摘要不含對話內容不代表全體AI使用:
    "Private local summary · no chat content · not representative of all AI usage",
  "純本機個人摘要・不含對話內容・不代表全體 AI 使用":
    "Private local summary · no chat content · not representative of all AI usage",
} as const satisfies Readonly<Record<string, string>>);

export type UiCopyKey = keyof typeof ENGLISH_UI_COPY;

let activeLocale: UiLocale = "zh-TW";

export const UI_LOCALE_SESSION_PATHS = Object.freeze({
  "zh-TW": "/session/locale/zh-TW",
  en: "/session/locale/en",
} as const satisfies Readonly<Record<UiLocale, string>>);

export function uiLocaleFromSessionPath(pathname: string): UiLocale | null {
  if (pathname === UI_LOCALE_SESSION_PATHS.en) return "en";
  if (pathname === UI_LOCALE_SESSION_PATHS["zh-TW"]) return "zh-TW";
  return null;
}

export function uiLocaleSessionPath(
  locale: UiLocale,
  currentSearch = "",
): string {
  // Preserve only the gateway's one exact compact-view query. Locale fallback
  // never reflects arbitrary URL input into a navigation target.
  const search = currentSearch === "?view=pet" ? currentSearch : "";
  return `${UI_LOCALE_SESSION_PATHS[locale]}${search}`;
}

export function getUiLocale(): UiLocale {
  return activeLocale;
}

export function setUiLocale(locale: UiLocale): void {
  activeLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant-TW";
  }
}

export function uiCopy(key: UiCopyKey): string {
  return activeLocale === "en" ? ENGLISH_UI_COPY[key] : key;
}

export function formatUiNumber(
  value: number,
  options: Intl.NumberFormatOptions = {
    maximumFractionDigits: 0,
    useGrouping: true,
  },
): string {
  return new Intl.NumberFormat(activeLocale, options).format(value);
}

export function formatUiDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(activeLocale, options).format(value);
}

const HAN_PATTERN = /\p{Script=Han}/u;

type DynamicRule = Readonly<{
  pattern: RegExp;
  replace: (...groups: string[]) => string;
}>;

const DYNAMIC_ENGLISH_RULES: readonly DynamicRule[] = Object.freeze([
  {
    pattern:
      /^啟用時會一次下載約 (.+) 的完整固定素材包（(.+) bytes）。這個請求只取素材，不會傳送你的用量、目前角色、解鎖狀態或服裝選擇；之後可隨時移除下載的完整素材，內建四位元祖角色的基本服裝圖像與文字不受影響。$/u,
    replace: (size, bytes) =>
      `Enabling downloads the complete fixed asset pack once (about ${size}; ${bytes} bytes). The request fetches assets only and sends no usage, selected character, unlock state, or outfit choice. You can remove the downloaded full assets at any time; the built-in basic-outfit art and text for the four original starter characters are unaffected.`,
  },
  {
    pattern: /^安靜時段 (.+)–(.+)$/u,
    replace: (start, end) => `Quiet hours ${start}–${end}`,
  },
  {
    pattern: /^每天 (.+) 檢查本機摘要；(.+)。$/u,
    replace: (time, quiet) =>
      `Check the local summary daily at ${time}; ${quiet}.`,
  },
  {
    pattern: /^TokenMonster (.+) 已準備好安裝。$/u,
    replace: (version) => `TokenMonster ${version} is ready to install.`,
  },
  {
    pattern: /^約剩 (\d+)%・視窗 (\d+) 小時$/u,
    replace: (remaining, hours) =>
      `About ${remaining}% left · ${hours}-hour window`,
  },
  {
    pattern: /^(.+) 剩餘估算$/u,
    replace: (family) => `${family} estimated remaining`,
  },
  {
    pattern: /^近 (\d+) 天沒有 token 用量可分析。$/u,
    replace: (days) => `No token usage to analyze over ${days} days.`,
  },
  {
    pattern: /^正在整理近 (\d+) 天的各家分析。$/u,
    replace: (days) => `Preparing provider analysis for the last ${days} days.`,
  },
  {
    pattern: /^近 (\d+) 天的各家分析暫時無法載入。$/u,
    replace: (days) =>
      `Provider analysis for the last ${days} days is temporarily unavailable.`,
  },
  {
    pattern: /^近 (\d+) 天共 (.+) tokens，來自 (\d+) 個供應商家族。$/u,
    replace: (days, total, families) =>
      `${total} tokens over ${days} days across ${families} provider families.`,
  },
  { pattern: /^輸入 (.+)$/u, replace: (value) => `Input ${value}` },
  { pattern: /^輸出 (.+)$/u, replace: (value) => `Output ${value}` },
  {
    pattern: /^(.+)：(.+) tokens$/u,
    replace: (label, value) => `${label}: ${value} tokens`,
  },
  {
    pattern: /^UTC (.+)：(.+) tokens$/u,
    replace: (date, value) => `UTC ${date}: ${value} tokens`,
  },
  {
    pattern: /^最近 28 個 UTC 日的每日 token 趨勢，共 (.+) tokens。$/u,
    replace: (total) =>
      `Daily token trend over the last 28 UTC days, ${total} tokens total.`,
  },
  { pattern: /^嗨，我是 (.+) 姊姊。$/u, replace: (name) => `Hi, I'm ${name}.` },
  { pattern: /^嗨，我是 (.+)。$/u, replace: (name) => `Hi, I'm ${name}.` },
  {
    pattern: /^點一下和 (.+) 夥伴打招呼$/u,
    replace: (name) => `Tap to say hello to ${name}`,
  },
  {
    pattern: /^點一下和 (.+) 打招呼$/u,
    replace: (name) => `Tap to say hello to ${name}`,
  },
  {
    pattern: /^TokenMonster (.+) 字母角色$/u,
    replace: (name) => `TokenMonster ${name} letter character`,
  },
  {
    pattern: /^上次更新於本機時間 (.+)$/u,
    replace: (time) => `Last updated at ${time} local time`,
  },
  {
    pattern: /^保留本機時間 (.+) 的資料$/u,
    replace: (time) => `Keeping data from ${time} local time`,
  },
  {
    pattern: /^上次成功於本機時間 (.+)$/u,
    replace: (time) => `Last successful update at ${time} local time`,
  },
  {
    pattern: /^更新於本機時間 (.+)$/u,
    replace: (time) => `Updated at ${time} local time`,
  },
  { pattern: /^已嘗試 (.+) 次$/u, replace: (count) => `${count} attempts` },
  {
    pattern: /^已遇見 (.+) \/ (.+) 位夥伴$/u,
    replace: (count, total) => `Met ${count} of ${total} companions`,
  },
  {
    pattern: /^下一次相遇進度 (.+)%$/u,
    replace: (progress) => `Next meeting progress: ${progress}%`,
  },
  {
    pattern:
      /^依近 28 天本機用量，你可能和 (.+) 比較熟；抽卡或自己挑都可以，之後也能隨時換。$/u,
    replace: (name) =>
      `Based on 28 days of local usage, ${name} may feel familiar. Draw a card or pick yourself; you can switch anytime.`,
  },
  { pattern: /^抽到了 (.+)$/u, replace: (name) => `You drew ${name}` },
  { pattern: /^(.+) 降生中…$/u, replace: (name) => `${name} is arriving…` },
  {
    pattern: /^下一套服裝：(.+)$/u,
    replace: (condition) => `Next outfit: ${condition}`,
  },
  {
    pattern:
      /^已累積 (.+) 個本機 (.+) token，再 (.+) 個即可解鎖 (.+) 的 (.+) 主題。$/u,
    replace: (current, provider, remaining, name, theme) =>
      `${current} local ${provider} tokens so far; ${remaining} more unlocks ${name}'s ${theme} theme.`,
  },
  {
    pattern:
      /^本機累積總用量已達 (.+) tokens，再 (.+) tokens 即可解鎖 (.+) 的 (.+) 主題。$/u,
    replace: (current, remaining, name, theme) =>
      `${current} total local tokens so far; ${remaining} more unlocks ${name}'s ${theme} theme.`,
  },
  {
    pattern: /^(.+) 暫時無法選擇，正在歡迎新夥伴。$/u,
    replace: (name) =>
      `${name} is unavailable while a new companion is welcomed.`,
  },
  {
    pattern: /^(.+) 暫時無法選擇，正在安全檢查角色進度。$/u,
    replace: (name) =>
      `${name} is unavailable while character progress is checked.`,
  },
  {
    pattern: /^(.+) 暫時無法選擇，正在套用角色或服裝。$/u,
    replace: (name) =>
      `${name} is unavailable while a character or outfit is applied.`,
  },
  {
    pattern: /^選擇 (.+) 作為第一位夥伴(.+)$/u,
    replace: (name, detail) =>
      `Choose ${name} as your first companion${detail.includes("推薦") ? ". Recommended from local usage, but you decide." : ""}`,
  },
  { pattern: /^選擇 (.+)$/u, replace: (name) => `Choose ${name}` },
  {
    pattern: /^解鎖了 (\d+) 位夥伴與 (\d+) 件服裝，到衣櫃看看$/u,
    replace: (characters, themes) =>
      `Unlocked ${characters} companions and ${themes} outfits. Visit the wardrobe.`,
  },
  {
    pattern: /^解鎖了 (\d+) 件新服裝，到衣櫃看看$/u,
    replace: (themes) => `Unlocked ${themes} new outfits. Visit the wardrobe.`,
  },
  {
    pattern: /^解鎖了 (\d+) 位新夥伴，到衣櫃看看$/u,
    replace: (characters) =>
      `Unlocked ${characters} new companions. Visit the wardrobe.`,
  },
  { pattern: /^(.+) 來了！$/u, replace: (name) => `${name} is here!` },
  {
    pattern: /^(.+) 的(.+)服裝準備好了！$/u,
    replace: (name, theme) => `${name}'s ${theme} outfit is ready!`,
  },
  { pattern: /^換上(.+)$/u, replace: (theme) => `Wear ${theme}` },
  {
    pattern: /^(.+)暫時停用，角色狀態完成後即可選擇。$/u,
    replace: (theme) =>
      `${theme} is temporarily unavailable until the character state settles.`,
  },
  {
    pattern: /^(.+)尚未解鎖，會隨本機使用里程自然解鎖。$/u,
    replace: (theme) =>
      `${theme} is locked and unlocks naturally through local usage milestones.`,
  },
  {
    pattern: /^(.+)服裝尚未解鎖。(.+)$/u,
    replace: (theme) =>
      `${theme} outfit is locked. ${theme ? "It unlocks naturally through local milestones." : ""}`,
  },
  {
    pattern: /^(.+)・正在更新，先沿用最近側寫$/u,
    replace: (state) => `${state} · Updating; showing the latest profile`,
  },
  {
    pattern: /^(.+)・暫時無法更新，先沿用最近側寫$/u,
    replace: (state) =>
      `${state} · Temporarily unavailable; showing the latest profile`,
  },
  {
    pattern: /^(.+)・超過十五分鐘，正在更新$/u,
    replace: (state) => `${state} · Over fifteen minutes old; updating`,
  },
  {
    pattern: /^(.+)・沿用最近側寫$/u,
    replace: (state) => `${state} · Showing the latest profile`,
  },
  {
    pattern: /^(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})（UTC）$/u,
    replace: (from, to) => `${from} to ${to} (UTC)`,
  },
  { pattern: /^心情 (.+)$/u, replace: (mood) => `Mood  ${mood}` },
  { pattern: /^特質 (.+)$/u, replace: (trait) => `Trait  ${trait}` },
  { pattern: /^成長 (.+)$/u, replace: (evolution) => `Growth  ${evolution}` },
  { pattern: /^主題・(.+)$/u, replace: (theme) => `Theme · ${theme}` },
  { pattern: /^因為・(.+)$/u, replace: (reason) => `Because · ${reason}` },
]);

function normalizePhrase(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function englishUiText(value: string): string {
  const normalized = normalizePhrase(value);
  const exact = (ENGLISH_UI_COPY as Readonly<Record<string, string>>)[
    normalized
  ];
  if (exact !== undefined) return exact;
  for (const rule of DYNAMIC_ENGLISH_RULES) {
    const match = rule.pattern.exec(normalized);
    if (match !== null) return rule.replace(...match.slice(1));
  }
  return normalized;
}

export function localizeUiText(value: string): string {
  return activeLocale === "en" ? englishUiText(value) : value;
}

function shouldSkipLocalization(node: Node): boolean {
  const parent = node instanceof Element ? node : node.parentElement;
  return (
    parent?.closest(
      "[data-localization-verbatim], [data-byok-transcript], textarea, input",
    ) !== null
  );
}

function localizeTextNode(node: Text): void {
  if (shouldSkipLocalization(node) || !HAN_PATTERN.test(node.data)) return;
  const leading = node.data.match(/^\s*/u)?.[0] ?? "";
  const trailing = node.data.match(/\s*$/u)?.[0] ?? "";
  const translated = englishUiText(node.data);
  if (translated !== normalizePhrase(node.data)) {
    node.data = `${leading}${translated}${trailing}`;
  }
}

const LOCALIZED_ATTRIBUTES = Object.freeze([
  "aria-label",
  "placeholder",
  "title",
] as const);

function localizeElement(element: Element): void {
  if (shouldSkipLocalization(element)) return;
  for (const attribute of LOCALIZED_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value === null || !HAN_PATTERN.test(value)) continue;
    const translated = englishUiText(value);
    if (translated !== normalizePhrase(value)) {
      element.setAttribute(attribute, translated);
    }
  }
  for (const child of element.childNodes) {
    if (child instanceof Text) localizeTextNode(child);
    else if (child instanceof Element) localizeElement(child);
  }
}

export function localizeDocument(root: HTMLElement = document.body): void {
  if (activeLocale !== "en") return;
  localizeElement(root);
}

export function observeLocalizedDocument(
  root: HTMLElement = document.body,
): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    if (activeLocale !== "en") return;
    for (const mutation of mutations) {
      if (
        mutation.type === "characterData" &&
        mutation.target instanceof Text
      ) {
        localizeTextNode(mutation.target);
      } else if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element
      ) {
        localizeElement(mutation.target);
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Text) localizeTextNode(node);
        else if (node instanceof Element) localizeElement(node);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...LOCALIZED_ATTRIBUTES],
  });
  return observer;
}

export function containsHan(value: string): boolean {
  return HAN_PATTERN.test(value);
}
