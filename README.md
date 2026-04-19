# Read Together

一个为两个人共读设计的零依赖 Web/PWA MVP。

## 已实现

- EPUB 上传与解析
- 共享书架
- 双账号切换
- 基于划线的批注与评论
- 阅读进度同步
- 个人 Markdown 笔记导出
- 长轮询实时刷新

## 运行

```powershell
& "C:\Users\cross\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" .\server.py
```

然后打开 `http://127.0.0.1:8000`。

## 说明

- 当前实现使用 `sqlite3` 持久化数据，数据库位于 [data/read_together.db](/E:/vibe_coding/ReadTogether/data/read_together.db)。
- EPUB 解析使用 Python 标准库完成，因此首版更适合结构规范的 EPUB 文件。
- “实时同步”采用长轮询事件流实现，适合 MVP 验证。

## 云端部署

当前代码已支持通过环境变量切换到：

- `STORAGE_MODE=object-storage`
- `DATABASE_MODE=postgres`

部署准备：

1. 复制 [.env.example](/E:/vibe_coding/ReadTogether/.env.example) 为部署环境变量文件并填入真实值。
2. 在服务器上安装 [requirements.txt](/E:/vibe_coding/ReadTogether/requirements.txt) 中的依赖。
3. 使用 [deploy/read-together.service.example](/E:/vibe_coding/ReadTogether/deploy/read-together.service.example) 托管应用进程。
4. 使用 [deploy/nginx.read-together.conf.example](/E:/vibe_coding/ReadTogether/deploy/nginx.read-together.conf.example) 配置反向代理和 HTTPS。

如果要把本地数据迁移到云端，可以使用：

```powershell
python .\scripts\migrate_to_cloud.py --source-sqlite .\data\read_together.db --source-books .\data\books --target-postgres-dsn "postgresql://..." --oss-bucket "..." --oss-endpoint "oss-cn-hangzhou.aliyuncs.com" --oss-key-id "..." --oss-key-secret "..."
```
