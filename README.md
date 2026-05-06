# LockerNote

你的备忘录保险箱。

不用注册，只用密码打开。文字、图片、链接，都能放进自己的私人空间。

## 当前实现

- 仅密码打开 / 创建保险箱
- 数据写入 PostgreSQL 数据库
- Express 后端 API
- PostgreSQL 表自动初始化
- Zeabur / Docker 部署支持
- 自动锁定
- 备忘录新建、编辑、搜索、置顶、删除、恢复、永久删除
- 富文本编辑
- 图片以 Base64 形式写入备忘录 HTML
- 链接卡片、附件元数据块
- JSON 导出数据库内容

## 本地运行

安装依赖：

```bash
npm install
```

配置环境变量：

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
npm start
```

然后打开：

```txt
http://localhost:3000
```

健康检查：

```txt
http://localhost:3000/health
```

## Zeabur 部署

需要配置环境变量：

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
```

如 Zeabur 注入的是 `POSTGRES_URL` 或 `POSTGRES_PRISMA_URL`，服务端也会自动读取。

## 注意

- 不要把真实数据库连接字符串提交到 GitHub。
- 这是单密码保险箱模型；相同密码会进入同一个保险箱。
