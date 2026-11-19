# mongosh 常用指令速查

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [通用日常运维、扩容与灾备手册](operations-and-recovery.md)

## 修订记录

| 日期       | 修订                                                              |
| ---------- | ----------------------------------------------------------------- |
| 2026-11-18 | 初稿: 汇总容器外直连 `mongosh` 的账号授权、副本集与连通性诊断片段 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 对齐代码块标识与文档元数据规范          |

> 本页为容器外直接执行原始 `mongosh` 的参考片段; 若使用 `codd` 生成器部署的实例, 优先在目标部署目录执行 `make shell`, 并留意默认服务端口为 `27117` (可按 `MONGO_PORT` 调整)。

## 一、账号与角色管理

```js
// 更新用户角色列表
db.updateUser('<admin-user>', {
  roles: [
    { role: 'readWrite', db: '<app_db_1>' },
    { role: 'readWrite', db: '<app_db_2>' },
    { role: 'readWrite', db: 'local' },
    { role: '__system', db: 'admin' },
  ],
});

// 增量授予角色
db.grantRolesToUser('<admin-user>', [{ role: '__system', db: 'admin' }]);

// 同时更新密码与角色
db.updateUser('<app-user>', {
  pwd: '<new-app-password>',
  roles: [
    { role: 'readWrite', db: '<app_db_1>' },
    { role: 'readWrite', db: '<app_db_2>' },
  ],
});

// 检查当前连接账号权限
db.runCommand({ connectionStatus: 1 }).authInfo;
```

## 二、副本集初始化与扩节点

```js
// 手动初始化副本集
rs.initiate({
  _id: 'rs0',
  members: [
    { _id: 0, host: 'node1:27117' },
    { _id: 1, host: 'node2:27117' },
  ],
});

// 追加副本集成员
rs.add('node3:27117');
```

## 三、终端连通性检查

```shell
mongosh --host 127.0.0.1:27117 --eval "db.hello()"
mongosh "mongodb://<admin-user>:<admin-password>@127.0.0.1:27117/admin?authSource=admin&directConnection=true"
```
