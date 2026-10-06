# NyaPassword 浏览器扩展隐私政策

[English](#english)

更新日期：2026 年 10 月 6 日

NyaPassword 是自建的密码管理器。本扩展只与**你自己指定的 NyaPassword 服务器**通信，开发者不运营任何收集用户数据的服务。

## 扩展处理哪些数据

- **账户信息**：服务器地址、登录邮箱。用于连接你的服务器。
- **密码库内容**：登录信息（用户名、密码、一次性密码密钥、通行密钥）、银行卡、身份 / 地址、笔记等你保存的条目。这些内容在你的设备上用主密码派生的密钥加密，发送到服务器的只有密文；服务器和开发者都无法解密。
- **网页上的表单**：为了识别登录框、填写和提示保存，扩展会在你访问的网页上读取表单字段，并读取当前标签页的网址，用来匹配已保存的条目。这些信息只在本机处理；只有在你确认“保存 / 更新”时，填写的用户名和密码才会作为加密条目同步到你的服务器。
- **本机存储**：加密的密码库副本和扩展设置（如自动锁定、不再询问的网站）保存在浏览器的扩展存储中；解锁后的会话密钥只保存在内存（`chrome.storage.session`），浏览器关闭即失效。
- **剪贴板**：你复制的密码会在 90 秒后从剪贴板清除。
- **桌面端联动（可选）**：开启“由桌面端解锁”后，扩展通过浏览器的 Native Messaging 与本机的 NyaPassword 桌面端通信，用于解锁。通信只在本机进行。

## 不做的事

- 不收集统计、分析或崩溃数据，不包含任何第三方 SDK 或广告。
- 不把数据发送给开发者或任何第三方；唯一的网络目标是你设置的服务器。
- 不出售数据，不把数据用于与密码管理无关的用途，不用于评估信用或贷款资格。

## 数据保存在哪里、如何删除

数据保存在你的设备和你自己的服务器上。在扩展中退出登录会删除本机的加密密码库副本；卸载扩展会删除扩展在本机保存的全部数据。服务器上的数据由服务器的运营者（通常就是你自己）保管和删除。

## 联系

问题和建议请在 [GitHub Issues](https://github.com/stevennight/NyaPassword-chrome/issues) 提出。

---

<a id="english"></a>

# NyaPassword Browser Extension Privacy Policy

Last updated: October 6, 2026

NyaPassword is a self-hosted password manager. This extension talks only to **the NyaPassword server you configure**. The developer does not operate any service that collects user data.

## Data the extension handles

- **Account information**: the server address and your sign-in email, used to connect to your server.
- **Vault contents**: logins (usernames, passwords, one-time code secrets, passkeys), cards, identities / addresses, notes and other items you save. They are encrypted on your device with a key derived from your master password; only ciphertext is sent to the server. Neither the server nor the developer can decrypt it.
- **Forms on web pages**: to detect login fields, fill them and offer to save, the extension reads form fields on the pages you visit and the address of the current tab, to match saved items. This is processed on your device only; a username and password are synced to your server, encrypted, only when you confirm "Save / Update".
- **Local storage**: an encrypted copy of the vault and the extension settings (such as auto-lock and sites you chose never to save) are kept in the browser's extension storage. The session key after unlocking is kept in memory only (`chrome.storage.session`) and is gone when the browser closes.
- **Clipboard**: a password you copy is cleared from the clipboard after 90 seconds.
- **Desktop app link (optional)**: with "Unlock with the desktop app" turned on, the extension talks to the NyaPassword desktop app on the same computer through the browser's Native Messaging, to unlock. This stays on your computer.

## What the extension does not do

- No analytics, telemetry or crash reporting; no third-party SDKs or ads.
- No data is sent to the developer or any third party; the only network destination is the server you set.
- Data is not sold, not used for purposes unrelated to password management, and not used to determine creditworthiness or for lending.

## Where data is kept and how to delete it

Data is kept on your devices and on your own server. Signing out of the extension removes the encrypted vault copy from the device; uninstalling the extension removes everything it stored on the device. Data on the server is kept and deleted by the server's operator (usually you).

## Contact

Please open an issue on [GitHub Issues](https://github.com/stevennight/NyaPassword-chrome/issues).
