# EasyNote

无需注册登录的 Web 版密码备忘录。用户只需要输入一个“保险箱密码”即可打开自己的备忘录空间；不再需要保险箱编号。

## 当前实现

- 仅密码打开 / 创建保险箱
- 数据写入 PostgreSQL 数据库
- Express 后端 API
- PostgreSQL 表自动初始化
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

## 环境变量

参考 `env.example`。

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
PORT=3000
```

## 注意

- 不要把真实数据库连接字符串提交到 GitHub。
- 这是单密码保险箱模型；相同密码会进入同一个保险箱。
