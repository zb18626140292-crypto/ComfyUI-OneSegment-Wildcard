import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";


const CLASS_NAME = "OneSegmentWildcardPicker";
const MANAGED = Symbol("oneSegmentManagedWidget");
const SEED_DEFAULTS_VERSION = 2;
const SEED_DEFAULTS_PROPERTY = "one_segment_seed_defaults_version";
const MAX_SEED = 1125899906842624;
const SEGMENT_MODES = ["每个非空行是一段", "自动", "空行分段"];
const PICK_MODES = ["所有片段等概率", "每个文件等概率"];
const SEED_CONTROLS = ["fixed", "increment", "decrement", "randomize"];
const UPLOAD_PREFIX = "本节点/uploads/";
const RESIZE_HANDLE_SIZE = 28;
const RESIZE_BOTTOM_PADDING = 26;
const MANAGERS = new Set();
const PENDING_UPLOAD_DELETIONS = new Set();
let uploadSyncPromise = null;
let uploadSyncTimer = null;


async function fetchUploadedPaths() {
    const response = await api.fetchApi("/one_segment_wildcard/list_uploads");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "读取 uploads 文件夹失败");
    return Array.isArray(result.paths) ? result.paths.filter((path) => typeof path === "string") : [];
}


function mergeUploadedEntries(entries, uploadedPaths) {
    const visibleUploads = uploadedPaths.filter(
        (path) => !PENDING_UPLOAD_DELETIONS.has(path)
    );
    const uploadedSet = new Set(visibleUploads);
    const merged = entries.filter(
        (entry) => !entry.path.startsWith(UPLOAD_PREFIX) || uploadedSet.has(entry.path)
    );
    const known = new Set(merged.map((entry) => entry.path));
    for (const path of visibleUploads) {
        if (!known.has(path)) {
            merged.push({ path, enabled: true });
            known.add(path);
        }
    }
    return merged;
}


async function forceRefreshAllUploadedFiles() {
    if (uploadSyncPromise) await uploadSyncPromise;
    return refreshAllUploadedFiles();
}


async function refreshAllUploadedFiles() {
    if (uploadSyncPromise) return uploadSyncPromise;
    uploadSyncPromise = (async () => {
        try {
            const paths = await fetchUploadedPaths();
            for (const manager of MANAGERS) {
                const current = readEntries(manager.stateWidget);
                const merged = mergeUploadedEntries(current, paths);
                if (JSON.stringify(current) !== JSON.stringify(merged)) {
                    writeEntries(manager.stateWidget, merged);
                    manager.rebuild?.();
                }
            }
        } catch (error) {
            console.warn("[OneSegmentWildcard] uploads 自动同步失败", error);
        } finally {
            uploadSyncPromise = null;
        }
    })();
    return uploadSyncPromise;
}


function removePathFromAllManagers(path) {
    for (const manager of MANAGERS) {
        const current = readEntries(manager.stateWidget);
        const next = current.filter((entry) => entry.path !== path);
        if (next.length !== current.length) {
            writeEntries(manager.stateWidget, next);
            manager.rebuild?.();
        }
    }
}


function registerManager(manager) {
    MANAGERS.add(manager);
    if (!uploadSyncTimer) {
        uploadSyncTimer = window.setInterval(refreshAllUploadedFiles, 3000);
        window.addEventListener("focus", refreshAllUploadedFiles);
    }
    refreshAllUploadedFiles();
}


function unregisterManager(manager) {
    MANAGERS.delete(manager);
    if (!MANAGERS.size && uploadSyncTimer) {
        window.clearInterval(uploadSyncTimer);
        uploadSyncTimer = null;
        window.removeEventListener("focus", refreshAllUploadedFiles);
    }
}


function normalizedSavedValues(values) {
    if (!Array.isArray(values)) return null;
    const state = typeof values[0] === "string" ? values[0] : "[]";
    const segmentMode = values.find((value) => SEGMENT_MODES.includes(value)) || SEGMENT_MODES[0];
    const pickMode = values.find((value) => PICK_MODES.includes(value)) || PICK_MODES[0];
    const control = values.find((value) => SEED_CONTROLS.includes(value)) || "randomize";
    const numericValues = values
        .slice(2)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
    const seed = Math.max(0, Math.min(MAX_SEED, Math.trunc(numericValues.at(-1) ?? 1)));
    return [state, segmentMode, pickMode, seed, control];
}


function canonicalWidgetValues(node) {
    const widgetValue = (name, fallback) =>
        node.widgets?.find((widget) => widget.name === name)?.value ?? fallback;
    const seedValue = Number(widgetValue("seed", 1));
    return [
        String(widgetValue("文件状态", "[]")),
        SEGMENT_MODES.includes(widgetValue("分段方式", ""))
            ? widgetValue("分段方式", SEGMENT_MODES[0])
            : SEGMENT_MODES[0],
        PICK_MODES.includes(widgetValue("抽取方式", ""))
            ? widgetValue("抽取方式", PICK_MODES[0])
            : PICK_MODES[0],
        Number.isFinite(seedValue)
            ? Math.max(0, Math.min(MAX_SEED, Math.trunc(seedValue)))
            : 1,
        SEED_CONTROLS.includes(widgetValue("control_after_generate", ""))
            ? widgetValue("control_after_generate", "randomize")
            : "randomize",
    ];
}


function applyCanonicalWidgetValues(node, values) {
    if (!values) return;
    const names = [
        "文件状态",
        "分段方式",
        "抽取方式",
        "seed",
        "control_after_generate",
    ];
    names.forEach((name, index) => {
        const widget = node.widgets?.find((item) => item.name === name);
        if (widget) widget.value = values[index];
    });
}


function normalizeRuntimeWidgets(node) {
    node.properties = node.properties || {};
    const needsDefaultMigration =
        Number(node.properties[SEED_DEFAULTS_PROPERTY] || 0) < SEED_DEFAULTS_VERSION;

    const pickWidget = node.widgets?.find((widget) => widget.name === "抽取方式");
    const seedWidget = node.widgets?.find((widget) => widget.name === "seed");
    const controlWidget = node.widgets?.find(
        (widget) => widget.name === "control_after_generate"
    );
    if (!seedWidget || !controlWidget) return;

    const hadInvalidPickMode = Boolean(pickWidget && !PICK_MODES.includes(pickWidget.value));
    if (hadInvalidPickMode) pickWidget.value = PICK_MODES[0];
    const numericSeed = Number(seedWidget.value);
    seedWidget.value = Number.isFinite(numericSeed)
        ? Math.max(0, Math.min(MAX_SEED, Math.trunc(numericSeed)))
        : 1;
    if (!SEED_CONTROLS.includes(controlWidget.value)) controlWidget.value = "randomize";
    if (needsDefaultMigration && hadInvalidPickMode && controlWidget.value === "fixed") {
        controlWidget.value = "randomize";
    }

    // 新节点以及仍处于旧默认值的节点，默认行为与 Easy Use 随机种一致。
    if (needsDefaultMigration &&
        (seedWidget.value === 0 || seedWidget.value === 1) &&
        controlWidget.value === "fixed") {
        seedWidget.value = 1;
        controlWidget.value = "randomize";
    }
    if (needsDefaultMigration) {
        node.properties[SEED_DEFAULTS_PROPERTY] = SEED_DEFAULTS_VERSION;
    }
    app.graph?.setDirtyCanvas(true, true);
}


function installEasySeedButton(node) {
    const seedWidget = node.widgets?.find((widget) => widget.name === "seed");
    const controlWidget = node.widgets?.find(
        (widget) => widget.name === "control_after_generate"
    );
    if (!seedWidget || !controlWidget) return;

    let button = node.widgets?.find((widget) => widget.name === "🎲 Manual Random Seed");
    if (!button) {
        button = node.addWidget("button", "🎲 Manual Random Seed", null, () => {
            controlWidget.value = "fixed";
            seedWidget.value = Math.floor(Math.random() * (MAX_SEED + 1));
            seedWidget.callback?.(seedWidget.value);
            controlWidget.callback?.(controlWidget.value);
            app.graph?.setDirtyCanvas(true, true);
            app.queuePrompt(0, 1);
        }, { serialize: false });
    }
    button.hidden = false;
    seedWidget.linkedWidgets = [button, controlWidget];
}


function isTxt(file) {
    return file?.name?.toLowerCase().endsWith(".txt");
}


function fileName(path) {
    return String(path || "").split("/").pop() || path;
}


function readEntries(widget) {
    const raw = String(widget.value || "").trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((item) => item && typeof item.path === "string")
                .map((item) => ({ path: item.path, enabled: item.enabled !== false }));
        }
    } catch (_) {
        // 自动迁移 v2-v4 的换行路径格式。
    }
    return raw
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => ({ path, enabled: true }));
}


function writeEntries(widget, entries) {
    widget.value = JSON.stringify(entries);
    widget.callback?.(widget.value);
    app.graph?.setDirtyCanvas(true, true);
}


async function uploadFiles(files) {
    const paths = [];
    for (const file of files.filter(isTxt)) {
        const body = new FormData();
        body.append("file", file, file.name);
        const response = await api.fetchApi("/one_segment_wildcard/upload_txt", {
            method: "POST",
            body,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `上传失败：${file.name}`);
        paths.push(result.path);
    }
    return paths;
}


async function deleteUploadedPath(path) {
    if (!path.startsWith(UPLOAD_PREFIX)) return;
    const response = await api.fetchApi("/one_segment_wildcard/delete_uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [path] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "删除失败");
    if (Array.isArray(result.rejected) && result.rejected.includes(path)) {
        throw new Error(`服务器拒绝删除：${path}`);
    }
    const failure = Array.isArray(result.failed)
        ? result.failed.find((item) => item?.path === path)
        : null;
    if (failure) throw new Error(failure.error || `无法删除：${path}`);
}


function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}


function fittedText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
        value = value.slice(0, -1);
    }
    return `${value}…`;
}


function canvasWidget(name, height, draw, mouse) {
    return {
        name,
        type: "custom",
        options: { serialize: false },
        value: null,
        lastY: 0,
        [MANAGED]: true,
        draw(ctx, node, width, y, widgetHeight) {
            this.lastY = y;
            // 某些新版前端会传入画布显示宽度而非节点逻辑宽度。
            // 强制使用 node.size[0]，并裁剪到节点内部，避免控件横向越界。
            const safeWidth = Math.max(120, Number(node.size?.[0]) || width);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, y, safeWidth, height);
            ctx.clip();
            draw.call(this, ctx, node, safeWidth, y, widgetHeight);
            ctx.restore();
        },
        mouse(event, pos, node) {
            return mouse?.call(this, event, pos, node) ?? false;
        },
        computeSize(width) {
            return [width, height];
        },
        serializeValue() {
            return undefined;
        },
    };
}


function installManager(node, stateWidget) {
    installEasySeedButton(node);
    // 仅扩大本节点类型的原生缩放命中区，不修改全局 LiteGraph 设置。
    node.constructor.resizeHandleSize = Math.max(
        Number(node.constructor.resizeHandleSize) || 15,
        RESIZE_HANDLE_SIZE
    );

    // 后端状态仍随工作流保存，但不参与界面布局。
    stateWidget.type = "hidden";
    stateWidget.computeSize = () => [0, 0];
    stateWidget.draw = () => {};
    if (stateWidget.inputEl) stateWidget.inputEl.style.display = "none";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,text/plain";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const manager = { node, stateWidget, rebuild: null };

    let importing = false;
    const toggleAnimations = new Map();
    const rowPositions = [];
    const deletingPaths = new Set();
    let dragState = null;

    function setCursor(cursor) {
        const canvasElement = app.canvas?.canvas;
        if (canvasElement && canvasElement.style.cursor !== cursor) {
            canvasElement.style.cursor = cursor;
        }
    }

    function cursorForPosition(pos) {
        if (!pos) return "";
        if (dragState) return "grabbing";
        const upload = node.widgets?.find(
            (widget) => widget[MANAGED] && widget.name === "TXT上传"
        );
        if (upload && pos[1] >= upload.lastY && pos[1] <= upload.lastY + 40) {
            return "pointer";
        }
        for (let index = 0; index < rowPositions.length; index++) {
            const rowY = rowPositions[index];
            if (!Number.isFinite(rowY) || pos[1] < rowY || pos[1] > rowY + 32) continue;
            if (pos[0] <= 52 || pos[0] >= node.size[0] - 43) return "pointer";
            return "grab";
        }
        return "";
    }

    function startToggleAnimation(path, from, to) {
        const animation = {
            from,
            to,
            start: performance.now(),
            duration: 180,
        };
        toggleAnimations.set(path, animation);
        const tick = () => {
            app.graph?.setDirtyCanvas(true, true);
            if (performance.now() - animation.start < animation.duration) {
                requestAnimationFrame(tick);
            } else {
                toggleAnimations.delete(path);
                app.graph?.setDirtyCanvas(true, true);
            }
        };
        requestAnimationFrame(tick);
    }

    function togglePosition(path, enabled) {
        const animation = toggleAnimations.get(path);
        if (!animation) return enabled ? 1 : 0;
        const linear = Math.min(1, (performance.now() - animation.start) / animation.duration);
        const eased = 1 - Math.pow(1 - linear, 3);
        return animation.from + (animation.to - animation.from) * eased;
    }

    function resizeToContent() {
        app.graph?.setDirtyCanvas(true, true);
        // 等待一帧完成控件布局，再以最后一个实际可见控件的位置紧凑节点。
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const currentWidth = node.size[0];
            let measuredBottom = 0;
            for (const widget of node.widgets || []) {
                if (widget.hidden || !Number.isFinite(widget.last_y) || widget.last_y <= 0) continue;
                const height = Number(widget.computedHeight) ||
                    Number(widget.computeSize?.(currentWidth)?.[1]) || 20;
                measuredBottom = Math.max(measuredBottom, widget.last_y + height);
            }
            const computedHeight = Number(node.computeSize?.()?.[1]) || node.size[1];
            const nextHeight = Math.ceil(
                measuredBottom > 0
                    ? measuredBottom + RESIZE_BOTTOM_PADDING
                    : computedHeight + RESIZE_BOTTOM_PADDING
            );
            node.setSize([currentWidth, nextHeight]);
            app.graph?.setDirtyCanvas(true, true);
        }));
    }

    async function removeEntry(path) {
        if (deletingPaths.has(path) || PENDING_UPLOAD_DELETIONS.has(path)) return;
        deletingPaths.add(path);
        if (path.startsWith(UPLOAD_PREFIX)) PENDING_UPLOAD_DELETIONS.add(path);
        dragState = null;

        // uploads 是所有节点的共享源；删除上传文件时立即从所有实例移除。
        if (path.startsWith(UPLOAD_PREFIX)) {
            removePathFromAllManagers(path);
        } else {
            const entries = readEntries(stateWidget).filter((item) => item.path !== path);
            writeEntries(stateWidget, entries);
            rebuild();
        }
        try {
            await deleteUploadedPath(path);
        } catch (error) {
            console.warn(`[OneSegmentWildcard] 已从列表移除，但清理上传文件失败：${path}`, error);
            window.alert(`TXT 文件删除失败，将重新显示该文件：\n${error.message}`);
        } finally {
            deletingPaths.delete(path);
            PENDING_UPLOAD_DELETIONS.delete(path);
            forceRefreshAllUploadedFiles();
        }
    }

    async function addFiles(files) {
        const txtFiles = Array.from(files || []).filter(isTxt);
        if (!txtFiles.length || importing) return;
        importing = true;
        app.graph?.setDirtyCanvas(true, true);
        try {
            await uploadFiles(txtFiles);
            await forceRefreshAllUploadedFiles();
        } catch (error) {
            console.error("[OneSegmentWildcard]", error);
            window.alert(`TXT 导入失败：${error.message}`);
        } finally {
            importing = false;
            fileInput.value = "";
            app.graph?.setDirtyCanvas(true, true);
        }
    }

    function uploadWidget() {
        return canvasWidget(
            "TXT上传",
            40,
            function (ctx, _node, width, y) {
                ctx.save();
                roundRect(ctx, 10, y + 4, width - 20, 32, 7);
                ctx.fillStyle = "rgba(100,100,100,.22)";
                ctx.fill();
                ctx.setLineDash([5, 4]);
                ctx.strokeStyle = importing ? "#7b9bd1" : "#888";
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = "#111";
                ctx.font = "14px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(importing ? "正在导入 TXT…" : "＋ 上传或拖入 TXT 文件", width / 2, y + 20);
                ctx.restore();
            },
            function (event) {
                if (event.type === "pointermove" || event.type === "mousemove") {
                    setCursor("pointer");
                    return false;
                }
                if ((event.type !== "pointerdown" && event.type !== "mousedown") || importing) return false;
                fileInput.click();
                return true;
            }
        );
    }

    function emptyWidget() {
        return canvasWidget("TXT空列表", 28, (ctx, _node, width, y) => {
            ctx.save();
            ctx.fillStyle = "#999";
            ctx.font = "12px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("暂无文件，可点击或拖入多个 TXT", width / 2, y + 14);
            ctx.restore();
        });
    }

    function rowWidget(entry, index) {
        return canvasWidget(
            `TXT文件_${index}`,
            32,
            function (ctx, _node, width, y) {
                rowPositions[index] = y;
                ctx.save();
                const isDragging = dragState?.path === entry.path;
                ctx.globalAlpha = entry.enabled ? (isDragging ? 0.72 : 1) : 0.48;
                roundRect(ctx, 10, y + 3, width - 20, 26, 13);
                ctx.fillStyle = "rgba(105,105,105,.34)";
                ctx.fill();
                ctx.strokeStyle = isDragging ? "#5f8fd8" : "rgba(155,155,155,.75)";
                ctx.lineWidth = isDragging ? 2 : 1;
                ctx.stroke();

                const position = togglePosition(entry.path, entry.enabled);
                roundRect(ctx, 14, y + 9, 34, 14, 7);
                const trackRed = Math.round(119 + (111 - 119) * position);
                const trackGreen = Math.round(119 + (150 - 119) * position);
                const trackBlue = Math.round(119 + (214 - 119) * position);
                ctx.fillStyle = `rgb(${trackRed},${trackGreen},${trackBlue})`;
                ctx.fill();

                ctx.beginPath();
                ctx.arc(21 + 20 * position, y + 16, 6, 0, Math.PI * 2);
                ctx.fillStyle = "#f4f4f4";
                ctx.fill();
                ctx.strokeStyle = "rgba(0,0,0,.25)";
                ctx.stroke();

                ctx.fillStyle = "#666";
                ctx.font = "bold 13px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("≡", 59, y + 16);

                ctx.fillStyle = "#222";
                ctx.font = "13px Arial";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(fittedText(ctx, fileName(entry.path), width - 123), 71, y + 16);

                ctx.fillStyle = "#e58b8b";
                ctx.font = "bold 18px Arial";
                ctx.textAlign = "center";
                ctx.fillText("×", width - 24, y + 16);

                if (dragState && dragState.target === index) {
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = "#4f83d1";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(16, y + 1);
                    ctx.lineTo(width - 16, y + 1);
                    ctx.stroke();
                }
                ctx.restore();
            },
            function (event, pos) {
                const isDown = event.type === "pointerdown" || event.type === "mousedown";
                const isClick = event.type === "click" || event.type === "pointertap";
                const isMove = event.type === "pointermove" || event.type === "mousemove";
                const isUp = event.type === "pointerup" || event.type === "mouseup";
                const x = pos[0];
                const localY = pos[1] - this.lastY;
                if ((isDown || isClick) && (localY < 2 || localY > 30)) return false;

                if (isDown && x <= 52) {
                    setCursor("pointer");
                    const entries = readEntries(stateWidget);
                    if (!entries[index]) return false;
                    const wasEnabled = entries[index].enabled;
                    entries[index].enabled = !wasEnabled;
                    startToggleAnimation(entry.path, wasEnabled ? 1 : 0, wasEnabled ? 0 : 1);
                    writeEntries(stateWidget, entries);
                    rebuild();
                    return true;
                }

                if ((isDown || isClick) && x >= node.size[0] - 52) {
                    setCursor("pointer");
                    removeEntry(entry.path);
                    return true;
                }

                if (isDown) {
                    setCursor("grabbing");
                    dragState = {
                        path: entry.path,
                        from: index,
                        target: index,
                    };
                    app.graph?.setDirtyCanvas(true, true);
                    return true;
                }

                if (isMove && dragState?.path === entry.path) {
                    setCursor("grabbing");
                    let target = dragState.target;
                    let bestDistance = Number.POSITIVE_INFINITY;
                    rowPositions.forEach((rowY, rowIndex) => {
                        if (!Number.isFinite(rowY)) return;
                        const distance = Math.abs(pos[1] - (rowY + 16));
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            target = rowIndex;
                        }
                    });
                    dragState.target = target;
                    app.graph?.setDirtyCanvas(true, true);
                    return true;
                }

                if (isUp && dragState?.path === entry.path) {
                    const entries = readEntries(stateWidget);
                    const from = entries.findIndex((item) => item.path === dragState.path);
                    const target = Math.max(0, Math.min(entries.length - 1, dragState.target));
                    if (from >= 0 && target !== from) {
                        const [moved] = entries.splice(from, 1);
                        entries.splice(target, 0, moved);
                        writeEntries(stateWidget, entries);
                    }
                    dragState = null;
                    setCursor("grab");
                    rebuild();
                    return true;
                }
                return false;
            }
        );
    }

    function rebuild() {
        rowPositions.length = 0;
        node.widgets = (node.widgets || []).filter((widget) => !widget[MANAGED]);
        const entries = readEntries(stateWidget);
        const managed = [uploadWidget()];
        if (entries.length) {
            entries.forEach((entry, index) => managed.push(rowWidget(entry, index)));
        } else {
            managed.push(emptyWidget());
        }
        for (const widget of managed) node.addCustomWidget(widget);

        // 放在隐藏状态控件之后，因此上传区位于普通设置控件上方。
        for (const widget of managed) {
            const currentIndex = node.widgets.indexOf(widget);
            if (currentIndex >= 0) node.widgets.splice(currentIndex, 1);
        }
        const stateIndex = node.widgets.indexOf(stateWidget);
        node.widgets.splice(Math.max(0, stateIndex + 1), 0, ...managed);
        resizeToContent();
    }
    manager.rebuild = rebuild;

    fileInput.onchange = () => addFiles(fileInput.files);

    const oldDrop = node.onDragDrop;
    node.onDragDrop = function (event) {
        const files = Array.from(event.dataTransfer?.files || []).filter(isTxt);
        if (files.length) {
            event.preventDefault?.();
            addFiles(files);
            return true;
        }
        return oldDrop?.apply(this, arguments) ?? false;
    };

    const oldOver = node.onDragOver;
    node.onDragOver = function (event) {
        if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file")) {
            event.preventDefault?.();
            return true;
        }
        return oldOver?.apply(this, arguments) ?? false;
    };

    const oldConfigure = node.onConfigure;
    node.onConfigure = function () {
        const info = arguments[0];
        const normalized = normalizedSavedValues(info?.widgets_values);
        if (normalized) info.widgets_values = normalized;
        const result = oldConfigure?.apply(this, arguments);
        // 部分前端会把 serialize:false 的 Canvas 行也计入恢复位置，按名称重新赋值。
        applyCanonicalWidgetValues(this, normalized);
        normalizeRuntimeWidgets(this);
        setTimeout(() => {
            rebuild();
            refreshAllUploadedFiles();
        }, 0);
        return result;
    };

    const oldSerialize = node.onSerialize;
    node.onSerialize = function (info) {
        const result = oldSerialize?.apply(this, arguments);
        // 自定义文件行不参与序列化；按控件名称重建固定顺序，避免旧工作流错位。
        info.widgets_values = canonicalWidgetValues(this);
        return result;
    };

    // 新版 LiteGraph 偶尔不会把右侧点击交给自定义 widget，这里增加节点级删除命中。
    const oldMouseDown = node.onMouseDown;
    node.onMouseDown = function (event, pos, canvas) {
        if (pos && pos[0] >= this.size[0] - 48) {
            const entries = readEntries(stateWidget);
            for (let index = 0; index < rowPositions.length; index++) {
                const rowY = rowPositions[index];
                if (Number.isFinite(rowY) && pos[1] >= rowY && pos[1] <= rowY + 32) {
                    const entry = entries[index];
                    if (entry) {
                        setCursor("pointer");
                        removeEntry(entry.path);
                        return true;
                    }
                }
            }
        }
        return oldMouseDown?.apply(this, arguments);
    };

    const oldMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, pos, canvas) {
        const result = oldMouseMove?.apply(this, arguments);
        const inResizeCorner = pos &&
            pos[0] >= this.size[0] - RESIZE_HANDLE_SIZE &&
            pos[1] >= this.size[1] - RESIZE_HANDLE_SIZE;
        setCursor(inResizeCorner ? "nwse-resize" : cursorForPosition(pos));
        return result;
    };

    const oldDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        const result = oldDrawForeground?.apply(this, arguments);
        if (!this.collapsed && this.resizable !== false) {
            const right = this.size[0] - 5;
            const bottom = this.size[1] - 5;
            ctx.save();
            ctx.strokeStyle = "rgba(105,105,105,.75)";
            ctx.lineWidth = 1.5;
            for (const offset of [7, 12, 17]) {
                ctx.beginPath();
                ctx.moveTo(right - offset, bottom);
                ctx.lineTo(right, bottom - offset);
                ctx.stroke();
            }
            ctx.restore();
        }
        return result;
    };

    const oldInResizeCorner = node.inResizeCorner;
    node.inResizeCorner = function (x, y) {
        if (this.resizable !== false &&
            x >= this.pos[0] + this.size[0] - RESIZE_HANDLE_SIZE &&
            x <= this.pos[0] + this.size[0] + 4 &&
            y >= this.pos[1] + this.size[1] - RESIZE_HANDLE_SIZE &&
            y <= this.pos[1] + this.size[1] + 4) {
            return true;
        }
        return oldInResizeCorner?.apply(this, arguments) ?? false;
    };

    const oldMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function () {
        if (!dragState) setCursor("");
        return oldMouseLeave?.apply(this, arguments);
    };

    const oldMouseUp = node.onMouseUp;
    node.onMouseUp = function () {
        if (!dragState) setCursor("");
        return oldMouseUp?.apply(this, arguments);
    };

    const releaseAbandonedDrag = () => {
        if (!dragState) return;
        dragState = null;
        setCursor("");
        rebuild();
    };
    document.addEventListener("pointerup", releaseAbandonedDrag);
    document.addEventListener("mouseup", releaseAbandonedDrag);

    const oldRemoved = node.onRemoved;
    node.onRemoved = function () {
        setCursor("");
        unregisterManager(manager);
        document.removeEventListener("pointerup", releaseAbandonedDrag);
        document.removeEventListener("mouseup", releaseAbandonedDrag);
        fileInput.remove();
        return oldRemoved?.apply(this, arguments);
    };

    registerManager(manager);
    rebuild();
    // nodeCreated 在不同前端版本中的时序不同，稍后统一完成一次旧工作流迁移。
    setTimeout(() => normalizeRuntimeWidgets(node), 100);
}


app.registerExtension({
    name: "OneSegmentWildcard.CanvasFileList",
    nodeCreated(node) {
        if (node.comfyClass !== CLASS_NAME) return;
        const stateWidget = node.widgets?.find((item) => item.name === "文件状态");
        if (stateWidget) installManager(node, stateWidget);
    },
});
