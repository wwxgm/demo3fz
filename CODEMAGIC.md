# 用 Codemagic 打包 IPA（无 Mac）

工具全名是 **[Codemagic](https://codemagic.io)**，不是 CodeImage。  
本仓库已放好 `codemagic.yaml`。

---

## 先说清楚：能不能「完全不花钱」

| 项目 | 费用 |
|------|------|
| Codemagic 云构建 | 有免费额度（分钟有限） |
| **能装到 iPhone 的签名 IPA** | 必须 **Apple 开发者账号（约 $99/年）** |

没有 Apple 年费：Codemagic 可以帮你在云端编译，但**签不出**能长期安装的正式 IPA。  
免费验证请继续用：Safari「添加到主屏幕」或 Expo Go。

---

## 操作步骤（有开发者账号时）

### 1. 把代码推到 GitHub
在 `D:\www\ai\iphone` 初始化仓库并推送（若还没有）：

```bash
cd D:\www\ai\iphone
git init
git add .
git commit -m "init iphone expo app"
# 在 GitHub 新建空仓库后：
git remote add origin https://github.com/你的用户名/iphone-hello.git
git push -u origin main
```

### 2. 注册并连接 Codemagic
1. 打开 https://codemagic.io 注册登录  
2. **Add application** → 选 GitHub → 选中 `iphone-hello` 仓库  
3. 项目类型选 **React Native** / 有 yaml 即可  
4. 点 **Check for configuration file**，应扫到根目录的 `codemagic.yaml`

### 3. 配置苹果签名（必须）
1. Apple Developer → 创建 App ID：`com.local.iphonehello`（可改成你自己的）  
2. Codemagic → Teams → **Integrations** → 添加 **App Store Connect API Key**  
3. 应用设置 → **iOS code signing** → Automatic  
4. 编辑 `codemagic.yaml`：  
   - 取消注释 `integrations.app_store_connect`  
   - 取消注释 `ios_signing` 里的 `distribution_type` / `bundle_identifier`

### 4. 开始打包
1. 选中 workflow：**iOS IPA (Expo)**  
2. 点 **Start new build**  
3. 等云端 Mac 跑完（约 10–20 分钟）  
4. 在 Artifacts 下载 **`.ipa`**

### 5. 装到 iPhone
- **推荐**：`distribution_type: app_store` → 发布到 **TestFlight** → 手机装 TestFlight 安装  
- 或 **ad_hoc**：先把 iPhone UDID 加到开发者后台，再装 IPA（需电脑工具/第三方安装器）

---

## 官方文档
- React Native / Expo：https://docs.codemagic.io/yaml-quick-start/building-a-react-native-app/  
- iOS 签名：https://docs.codemagic.io/flutter-code-signing/ios-code-signing/

---

## 更简单的替代（同样无 Mac）
你这个本来就是 Expo 项目，用 **EAS** 往往比 Codemagic 少踩坑：

```bash
npm i -g eas-cli
eas login
eas build -p ios
```

同样需要 Apple 开发者账号才能装真机。
