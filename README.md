# NyaPassword 浏览器扩展（chrome）

Chrome / Edge（Chromium 内核）的 Manifest V3 扩展：自动填充登录、一次性密码、保存 / 更新提示、通行密钥（passkey）、工具栏弹窗和完整的密码库页面。客户端核心是 common 的 Rust 核心编译成的 WebAssembly，只运行在扩展的 Service Worker 里。

设计见 [../common/docs/设计方案.md](../common/docs/设计方案.md) §10.4。

## 功能

- 登录框识别：`autocomplete` 属性优先，其次中英文关键词（`../common/autofill/keywords.json`）；支持 Shadow DOM、多步登录、动态码框、注册表单。
- 内联菜单：点击 / 聚焦登录框时弹出（扩展自己的 iframe，网页读不到内容）；选择后填写用户名、密码和一次性密码。
- 银行卡、身份 / 收货地址：识别卡号、有效期（含月 / 年下拉框）、CVV、姓名、手机、省市区（下拉框按名称匹配）、邮编；从内联菜单选择保存的银行卡或身份填写。银行卡只填到 https 页面（本机地址除外）。
- 打开页面时自动填写（默认关闭，在工具栏弹窗 ⚙ 里打开）：只有一个匹配的登录、且是 https 页面时填写用户名和密码。
- 填写只发给与条目网址匹配的 frame：来源由浏览器报告（`sender.origin`），不信任网页提供的信息；内联菜单刚打开时和被遮挡 / 透明时的点击会被忽略（防点击劫持）。
- 保存 / 更新：提交表单后提示保存新登录或更新密码（旧密码进入历史）；页面跳转后在同一网站的下一页继续提示；可设置某个网站不再询问。
- 通行密钥：接管 `navigator.credentials.create/get`，在 NyaPassword 中保存和使用（也可以选“使用其他设备”交给浏览器）；条件式（自动填充）请求交给浏览器处理。
- 工具栏弹窗：当前网站的登录（填写、复制用户名 / 密码 / 验证码）、全局搜索（支持拼音）、生成密码；徽标显示匹配数量。
- 快捷键 `Ctrl+Shift+L`：填写当前网站的第一个匹配登录。
- 完整密码库：`vault.html`，与网页版 / 桌面端同一套界面（common/web）。
- 自动锁定：空闲超时、系统锁屏（可在工具栏弹窗 ⚙ 里关闭）；会话密钥只保存在 `chrome.storage.session`（内存），浏览器关闭即失效。
- 复制的密码 90 秒后从剪贴板清除（offscreen 文档）。

## 开发

```powershell
npm --prefix ..\common\web install; npm --prefix ..\common\web run wasm   # 构建 WASM 核心（需要 wasm-bindgen-cli）
npm install
npm run build             # 输出 .output\chrome-mv3（在 chrome://extensions 开发者模式下“加载已解压的扩展程序”）
npm run check; npm test
node tests\e2e.mjs        # 端到端：新服务端 + Chromium 加载扩展，测试填写、保存提示、通行密钥、银行卡、地址
node tests\matrix.mjs     # 真实网站登录页的表单识别（只打开页面，不输入）；结果记到 ../common/autofill/matrix.md
```

端到端测试使用 `..\target\debug\nyapassword-server.exe`（先在 `..\server` 里 `cargo build`），Playwright 浏览器放在 `D:\Software\Cache\ms-playwright`（设置 `PLAYWRIGHT_BROWSERS_PATH`）。

## 发布

```powershell
.\scripts\release.ps1 0.1.0          # 改 VERSION / package.json、写 COMMON_REF、提交并打 tag
git push origin HEAD v0.1.0
```

GitHub Actions 构建 `NyaPassword-Chrome_<版本>.zip`（Chrome 网上应用店和 Edge 外接程序商店共用）并发布 Release；上架商店先手动上传（可设为“不公开”）。manifest 版本由 `VERSION` 换算：正式版 `x.y.z` → `x.y.z.1000`，预发布 `x.y.z-beta.N` → `x.y.z.N`。

CI 用两个只读部署密钥检出私有仓库：`COMMON_DEPLOY_KEY`（common）、`SERVER_DEPLOY_KEY`（server，端到端测试用）。
