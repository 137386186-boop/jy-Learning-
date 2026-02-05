# 数据库 Seed 说明

- 执行：在项目**根目录**或 **backend** 目录下运行  
  `cd backend && npx prisma db seed`
- 会依次：创建/更新平台（知乎、抖音、小红书、B站、快手）、插入若干条知乎 demo 内容、创建 admin 用户（默认密码见下方）、创建一条回复模板。
- 需已配置 `.env`（根目录或 backend 下）中的 `DATABASE_URL`、`DIRECT_URL`。  
  Seed 会先尝试加载 `../.env`，再加载 `./.env`。
- 若出现 TLS/证书错误，多为本机到数据库网络或 Supabase 证书问题，可在本地/服务器网络正常时再执行 seed。

**默认管理员**：用户名 `admin`，密码为环境变量 `ADMIN_PASSWORD`，未设置时为 `admin123`。
