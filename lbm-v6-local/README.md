# LBM Flow Lab · local v6

本地运行的 D2Q9 格子玻尔兹曼教学可视化，包含迁移、碰撞、圆形边界反弹和下一时间步释放。

## 运行

直接打开 `index.html`，或在此目录执行：

```powershell
python -m http.server 8767
```

然后访问 `http://127.0.0.1:8767/index.html`。

## 验证

```powershell
node engine.test.js
node ui.test.js
```

## 重建

```powershell
python build.py
```

`original-fragment.html` 和 `original-export.html` 是重建与测试所需的原始 v6 资源。
