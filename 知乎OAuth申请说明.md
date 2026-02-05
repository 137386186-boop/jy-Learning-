# 知乎 OAuth 申请说明

用于「快速回复」以知乎账号身份发评论，需先申请知乎开放平台应用并配置 OAuth。

## 一、申请入口

- **知乎开发者平台**：https://www.zhihu.com/org/signup  
  或搜索「知乎开放平台」→ 进入官网 → 登录/注册开发者账号。

- 若知乎已改版，可搜索「知乎 API 申请」「知乎开放平台 OAuth」找到当前申请入口。

## 二、申请步骤（概要）

1. **注册/登录知乎账号**  
   使用知乎账号登录，部分能力需完成实名或企业认证。

2. **创建应用**  
   - 进入「创建应用」或「应用管理」→「创建新应用」。  
   - 填写：应用名称、应用描述、**回调地址（Redirect URI）**。  
   - **回调地址**建议填（本地开发）：  
     `http://localhost:3001/api/oauth/zhihu/callback`  
   - 上线后改为你的线上域名，例如：  
     `https://你的域名/api/oauth/zhihu/callback`

3. **提交审核**  
   提交后等待知乎审核（通常数个工作日），审核通过后进入应用详情。

4. **获取凭证**  
   在应用详情页获取：  
   - **Client ID**（或 应用 ID / App Key）  
   - **Client Secret**（或 应用密钥 / App Secret）  

   请勿把 Secret 提交到代码仓库，只放在 `.env` 或服务器环境变量中。

## 三、在本项目中的配置

在项目 **根目录** 以及 **backend** 目录下的 `.env` 中增加（或修改）：

```env
# 知乎 OAuth（申请到后再填）
ZHIHU_CLIENT_ID=你的Client_ID
ZHIHU_CLIENT_SECRET=你的Client_Secret
```

- 回调地址已在上面给出，需与知乎应用里填写的 **完全一致**。  
- 配置好后重启后端，再在后台进行「知乎授权」并可使用「快速回复」发到知乎。

## 四、注意事项

- 知乎 API 有调用频率限制，超出会报错，需控制发评频率。  
- 发评论等能力可能需额外申请接口权限，以知乎开放平台当前文档为准。  
- 生产环境务必用 HTTPS 回调地址，并妥善保管 `ZHIHU_CLIENT_SECRET`。

申请到 **Client ID** 和 **Client Secret** 后，将二者填入 `.env` 并告诉我「已配置」，我可以继续帮你完成 OAuth 登录与「快速回复」发评论的对接。

---

## 五、本项目已实现的接口（配置好后即可使用）

- **发起知乎授权**：浏览器访问  
  `http://localhost:3001/api/oauth/zhihu`  
  会跳转到知乎登录授权，授权成功后回调并保存 token，再跳转到 `/admin/oauth?zhihu=ok`。

- **快速回复**：对某条内容发评论时，前端调用  
  `POST http://localhost:3001/api/reply`  
  Body: `{ "contentId": "内容ID", "text": "回复内容" }`  
  需先完成知乎 OAuth 授权；发评论接口以知乎开放平台当前文档为准，若路径有变更需在 `backend/src/routes/reply.ts` 中调整。
