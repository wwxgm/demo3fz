# 你好我需要这个 — 在 iPhone 上运行（无需 Mac）

项目目录：`D:\www\ai\iphone`

> **关于 CodeImage**：那是「代码截图美化」工具，**不能**打包成 iPhone App。  
> 没有 Mac 时，正确做法是下面两种之一。

---

## 推荐方案 A：PWA（最快，立刻能在 iPhone 当 App 用）

1. 电脑执行：

```bash
cd D:\www\ai\iphone\pwa
python server.py
```

2. 看终端打印的地址，例如 `http://192.168.x.x:8787/`
3. **iPhone 用 Safari** 打开该地址（不要用微信内置浏览器）
4. 点底部分享按钮 → **添加到主屏幕**
5. 主屏幕会出现 App 图标，打开后全屏显示：**你好我需要这个**

支持 iOS 17 / iPhone 17。手机和电脑需同一 Wi‑Fi。

---

## 方案 B：Expo Go（更接近原生 App）

1. iPhone App Store 安装 **Expo Go**
2. 电脑执行：

```bash
cd D:\www\ai\iphone
npm start
```

3. 用 Expo Go / 相机扫描二维码  
   若扫码失败（不同网段），改用：

```bash
npm run tunnel
```

4. 手机上应显示：**你好我需要这个**

支持 iOS 16+（含 iOS 17 / 新机型）。

---

## 以后要独立上架 App Store（仍可不买 Mac）

需要 Apple 开发者账号（年费），再用 Expo 云构建：

```bash
npm i -g eas-cli
eas login
eas build -p ios
```

云端打出 IPA → TestFlight 安装到你的 iPhone。日常开发用方案 A/B 即可。

---

## 目录说明

| 路径 | 作用 |
|------|------|
| `App.tsx` | Expo 界面文案 |
| `app.json` | App 名称 / iOS bundleId |
| `pwa/` | 可添加到主屏幕的网页版 App |
| `pwa/server.py` | 本机局域网服务 |
