# 商店上架材料

Chrome 应用商店和 Edge 加载项商店的填表内容和图片。图片由 `node scripts/store-assets.mjs` 生成（先 `npm run build`，需要 `..\target\debug\nyapassword-server.exe`）；演示数据都是虚构的（`*.example.com`）。

| 文件 | 用途 |
|---|---|
| `screenshots/zh-1..4.png`、`screenshots/en-1..4.png` | 截图，1280×800，中文 / 英文商品页各一套 |
| `promo-440x280-zh.png`、`promo-440x280-en.png` | 小型宣传图块（Chrome 必填，Edge 可选） |
| `icon-128.png` | Chrome 商店图标（96×96 图案 + 16 像素透明边） |
| `logo-300.png` | Edge 商店徽标（300×300） |

上传的安装包用 GitHub Release 里的 `NyaPassword-Chrome_<版本>.zip`（两家商店共用）。包里有 `_locales/zh_CN` 和 `_locales/en`，默认语言中文，所以商品页可以分别填中文和英文。

## 两家商店共用的内容

### 名称与简介

- 名称：`NyaPassword`（来自 `_locales`）
- 简介（来自 `_locales`，不超过 132 字符）
  - 中文：自建、端到端加密的密码管理器：自动填充、通行密钥、一次性密码。
  - English: Self-hosted, end-to-end encrypted password manager: autofill, passkeys and one-time codes.

### 详细说明（中文）

```text
NyaPassword 是自建的密码管理器：数据保存在你自己的服务器上，在本机加密后才同步，服务器和开发者都无法读取。

本扩展需要配合 NyaPassword 服务器使用（Docker 部署，开源：https://github.com/stevennight/NyaPassword-server）。

主要功能
• 自动填充：点击登录框旁的 NyaPassword 按钮，选择账号，一次填好用户名、密码和一次性密码；支持多步登录、动态码框和中文网站常见的表单。
• 保存与更新：登录或修改密码后提示保存，旧密码进入密码历史。
• 通行密钥（Passkey）：在 NyaPassword 中创建和使用通行密钥，跨设备同步。
• 一次性密码（TOTP）：保存两步验证密钥，填写时自动带上验证码。
• 银行卡、身份和地址：一键填写结账和收货表单。
• 工具栏弹窗：当前网站的账号、全局搜索（支持拼音）、生成密码。
• 完整密码库：与网页版、桌面端同一套界面。
• 安全设计：填写只发给与条目网址匹配的页面框架；内联菜单防点击劫持；空闲或系统锁屏时自动锁定；复制的密码 90 秒后清除；可对重要条目设置“使用前需要验证”。
• 由桌面端解锁（可选）：配合 NyaPassword 桌面端，用 Windows Hello 或 PIN 解锁。

隐私：不收集任何统计数据，不连接除你的服务器以外的任何地址。隐私政策：https://github.com/stevennight/NyaPassword-chrome/blob/main/PRIVACY.md
```

### 详细说明（English）

```text
NyaPassword is a self-hosted password manager: your data lives on your own server and is encrypted on your device before it syncs, so neither the server nor the developer can read it.

This extension needs a NyaPassword server (Docker, open source: https://github.com/stevennight/NyaPassword-server). The extension's interface is in Chinese.

Features
• Autofill: click the NyaPassword button in a login field, pick an account, and the username, password and one-time code are filled together. Multi-step logins and separate code fields are supported.
• Save and update: offers to save after you sign in or change a password; old passwords go to the password history.
• Passkeys: create and use passkeys stored in NyaPassword, synced across your devices.
• One-time codes (TOTP): store two-factor secrets; codes are filled along with the login.
• Cards, identities and addresses: fill checkout and shipping forms.
• Toolbar popup: logins for the current site, search across the vault, password generator.
• Full vault: the same interface as the web vault and the desktop app.
• Security: fills go only to frames whose address matches the item; the inline menu resists clickjacking; auto-lock when idle or when the system locks; copied passwords are cleared after 90 seconds; items can require the master password before use.
• Unlock with the desktop app (optional): unlock with Windows Hello or a PIN through the NyaPassword desktop app.

Privacy: no analytics, and no connections to anything but your server. Privacy policy: https://github.com/stevennight/NyaPassword-chrome/blob/main/PRIVACY.md
```

### 隐私政策网址

`https://github.com/stevennight/NyaPassword-chrome/blob/main/PRIVACY.md`（[PRIVACY.md](../PRIVACY.md)，中英双语）

## Chrome 应用商店

开发者控制台：<https://chrome.google.com/webstore/devconsole>（首次注册需支付 5 美元）。

### 商品详情（Store listing）

- 类别：效率 → 工具（Productivity → Tools）
- 语言：中文（简体）为默认；再添加 English，填英文详细说明，上传 `en-*` 截图和英文宣传图块
- 图标：`icon-128.png`；截图：`screenshots/zh-*.png`（英文页用 `en-*`）；小型宣传图块：`promo-440x280-*.png`
- 官方网址：`https://github.com/stevennight/NyaPassword-chrome`；支持网址：`https://github.com/stevennight/NyaPassword-chrome/issues`

### 隐私权规范（Privacy practices）

单一用途说明：

```text
A password manager: it saves and fills logins, passkeys, one-time codes, cards and addresses, and keeps them in sync, end-to-end encrypted, with the user's own self-hosted NyaPassword server.
```

权限理由（每项一栏）：

| 权限 | 填写内容 |
|---|---|
| `storage` | Stores the extension settings (auto-lock, autofill on page load, sites never to save) in chrome.storage.local, and the unlocked session key in chrome.storage.session (memory only, cleared when the browser closes). |
| `unlimitedStorage` | Keeps the encrypted offline copy of the user's vault in IndexedDB so it works offline and syncs incrementally; a large vault can exceed the default quota. |
| `tabs` | Reads the URL of the active tab to list matching logins in the popup and show the match count on the toolbar badge, sends fill requests to the tab's content script, and opens the full vault page in a tab. |
| `alarms` | Runs the auto-lock timer, periodic background sync with the user's server, and clears a copied password from the clipboard after 90 seconds. |
| `idle` | Locks the vault when the operating system screen locks (can be turned off in the settings). |
| `offscreen` | Creates an offscreen document with the CLIPBOARD reason to clear a copied password from the clipboard; a service worker cannot access the clipboard. |
| `webNavigation` | Uses webNavigation.getAllFrames to find the frames of a tab and send credentials only to the frame whose origin matches the saved item (login forms inside iframes). |
| `nativeMessaging` | Optional "unlock with the desktop app": talks to the NyaPassword desktop app on the same computer (host app.nya.password) to unlock with Windows Hello or a PIN. It must be a required permission because Chrome only binds runtime.connectNative when the service worker starts. |
| 主机权限 `http://*/*`、`https://*/*` | Content scripts on every site detect login, card and address forms, show the inline autofill menu, offer to save submitted credentials, and handle passkey requests (navigator.credentials). The extension also connects to the user's own server, whose address the user chooses. |

是否使用远程代码：**否**。

```text
No. All code, including the WebAssembly core, is bundled in the package; the extension does not load or evaluate code from the network.
```

数据使用（勾选）：

- [x] 个人身份信息（Personally identifiable information）：登录邮箱，以及用户保存的身份、地址条目
- [x] 身份验证信息（Authentication information）：密码、一次性密码密钥、通行密钥
- [x] 财务和付款信息（Financial and payment information）：用户保存的银行卡
- 其余类别不勾选

三项承诺全部勾选（不出售给第三方、不用于与单一用途无关的目的、不用于信用评估）。

### 分发（Distribution）

- 公开范围：**不公开（Unlisted）**，只有拿到链接的人能安装
- 地区：所有地区

### 测试说明（Test instructions）

审核员需要一个能登录的服务器才能测试。准备一个专门给审核用的测试账户（里面只放演示数据），把下面内容填进后台的测试说明栏。**账户和密码只填在商店后台，不要写进仓库。**

```text
The extension needs a NyaPassword server. A test account is ready:
1. Click the toolbar icon, then "登录 / 创建账户" (Sign in / Create account). The vault page opens; keep the "登录已有账户" (Sign in) tab.
2. Fill in:
   服务器 (Server): https://<server address>
   账号 (Account): <test email>
   主密码 (Master password): <test password>
   Secret Key: <A1-...>
   Then click "登录" (Sign in).
3. Open https://<a test login page> and click the NyaPassword button in the username field to fill a saved login.
The interface is in Chinese: 填写 = fill, 保存 = save, 更新 = update, 锁定 = lock.
```

## Edge 加载项商店

Partner Center：<https://partner.microsoft.com/dashboard/microsoftedge/overview>（个人开发者免费注册）。

- 可用性：**隐藏（Hidden）**，只能通过链接安装，相当于 Chrome 的“不公开”
- 市场：所有市场
- 属性：类别“效率（Productivity）”；隐私政策网址同上；网站网址同上
- 商品页（中文 / English 各一份）：描述用上面的详细说明（Edge 要求 250–10000 字符）；徽标 `logo-300.png`；小型宣传图块可用 `promo-440x280-*.png`；截图同上
- 搜索词（最多 7 个）：`password manager`、`passkey`、`autofill`、`self-hosted`、`2FA`、`密码管理器`、`自动填充`
- 认证说明（Notes for certification）：同 Chrome 的测试说明，并补充权限理由（可直接贴上面的表格内容）

## 上架之后

- Chrome 和 Edge 会各分配一个固定的扩展 ID。把两个 ID 填进桌面端“设置 → 浏览器扩展联动”即可，不再随加载路径变化。
- 之后发布新版本：上传新的 zip 并提交审核；两家都支持 API 上传，可以接进 release workflow。
