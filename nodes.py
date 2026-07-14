from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path


NODE_DIR = Path(__file__).resolve().parent
LOCAL_WILDCARDS = NODE_DIR / "wildcards"
NONE_OPTION = "（不使用）"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def _read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法识别 TXT 编码：{path.name}。请保存为 UTF-8 或 GB18030。")


def _delete_uploaded_paths(labels: list[str]) -> dict[str, list]:
    upload_dir = (LOCAL_WILDCARDS / "uploads").resolve()
    deleted: list[str] = []
    missing: list[str] = []
    rejected: list[str] = []
    failed: list[dict[str, str]] = []
    prefix = "本节点/uploads/"

    for label in labels:
        if not isinstance(label, str) or not label.startswith(prefix):
            rejected.append(str(label))
            continue
        relative = label[len(prefix):]
        candidate = (upload_dir / relative).resolve()
        try:
            candidate.relative_to(upload_dir)
        except ValueError:
            rejected.append(label)
            continue
        if candidate.is_file() and candidate.suffix.lower() == ".txt":
            try:
                candidate.unlink()
                deleted.append(label)
            except OSError as error:
                failed.append({"path": label, "error": str(error)})
        else:
            missing.append(label)
    return {
        "deleted": deleted,
        "missing": missing,
        "rejected": rejected,
        "failed": failed,
    }


def _uploaded_file_labels() -> list[str]:
    upload_dir = LOCAL_WILDCARDS / "uploads"
    if not upload_dir.is_dir():
        return []
    return [
        f"本节点/uploads/{path.name}"
        for path in sorted(upload_dir.glob("*.txt"), key=lambda item: item.name.casefold())
        if path.is_file()
    ]


def _roots() -> dict[str, Path]:
    roots = {"本节点": LOCAL_WILDCARDS}
    easy_use = NODE_DIR.parent / "ComfyUI-Easy-Use" / "wildcards"
    if easy_use.is_dir():
        roots["EasyUse"] = easy_use
    return roots


def _file_options() -> list[str]:
    options = [NONE_OPTION]
    for root_name, root in _roots().items():
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.txt"), key=lambda item: item.as_posix().lower()):
            relative = path.relative_to(root).as_posix()
            options.append(f"{root_name}/{relative}")
    return options


def _resolve(option: str) -> Path | None:
    if not option or option == NONE_OPTION or "/" not in option:
        return None
    root_name, relative = option.split("/", 1)
    root = _roots().get(root_name)
    if root is None:
        return None
    root = root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if candidate.is_file() and candidate.suffix.lower() == ".txt":
        return candidate
    return None


def _expand_file_list(file_list: str) -> list[tuple[str, Path]]:
    """Resolve an unlimited newline-separated list of files or glob patterns."""
    selected: list[tuple[str, Path]] = []
    seen: set[Path] = set()
    roots = _roots()

    for raw_line in file_list.splitlines():
        item = raw_line.strip().replace("\\", "/")
        if not item or item.startswith(("#", "//")):
            continue

        candidates: list[tuple[str, Path]] = []
        prefixed_root = None
        relative = item
        if "/" in item:
            possible_root, possible_relative = item.split("/", 1)
            if possible_root in roots:
                prefixed_root = possible_root
                relative = possible_relative

        search_roots = (
            [(prefixed_root, roots[prefixed_root])]
            if prefixed_root is not None
            else list(roots.items())
        )
        has_glob = any(character in relative for character in "*?[")

        for root_name, root in search_roots:
            if not root.is_dir():
                continue
            root = root.resolve()
            paths = root.glob(relative) if has_glob else (root / relative,)
            for path in paths:
                path = path.resolve()
                try:
                    path.relative_to(root)
                except ValueError:
                    continue
                if path.is_file() and path.suffix.lower() == ".txt":
                    label = f"{root_name}/{path.relative_to(root).as_posix()}"
                    candidates.append((label, path))

        # 没写目录时，也允许只填文件名并递归搜索两个通配符目录。
        if not candidates and prefixed_root is None and "/" not in item and not has_glob:
            for root_name, root in roots.items():
                if not root.is_dir():
                    continue
                root = root.resolve()
                for path in root.rglob(item):
                    if path.is_file() and path.suffix.lower() == ".txt":
                        label = f"{root_name}/{path.relative_to(root).as_posix()}"
                        candidates.append((label, path.resolve()))

        for label, path in candidates:
            if path not in seen:
                selected.append((label, path))
                seen.add(path)

    return selected


def _enabled_file_list(file_state: str) -> str:
    """Return enabled paths from the UI JSON; accept the old newline format for migration."""
    try:
        entries = json.loads(file_state)
    except (json.JSONDecodeError, TypeError):
        return file_state
    if not isinstance(entries, list):
        return ""
    paths: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("enabled", True) is False:
            continue
        path = entry.get("path")
        if isinstance(path, str) and path.strip():
            paths.append(path.strip())
    return "\n".join(paths)


def _clean_lines(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith(("#", "//"))
    ]


def _paragraphs(text: str) -> list[str]:
    blocks = re.split(r"\r?\n[ \t]*\r?\n+", text.strip())
    result: list[str] = []
    for block in blocks:
        lines = _clean_lines(block)
        if lines:
            result.append("\n".join(lines))
    return result


def _segments(path: Path, split_mode: str) -> list[str]:
    text = _read_text(path)
    if split_mode == "每个非空行是一段":
        return _clean_lines(text)
    if split_mode == "空行分段":
        return _paragraphs(text)
    # 自动模式：存在空白行时按段落，否则按非空行。
    if re.search(r"\r?\n[ \t]*\r?\n", text):
        return _paragraphs(text)
    return _clean_lines(text)


class OneSegmentWildcardPicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文件状态": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
                "分段方式": (["每个非空行是一段", "自动", "空行分段"],),
                "抽取方式": (["所有片段等概率", "每个文件等概率"],),
                "seed": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 1125899906842624,
                        "control_after_generate": True,
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("文本", "来源文件", "段落序号", "顺序组合文本")
    FUNCTION = "pick"
    CATEGORY = "文本/通配符"
    DESCRIPTION = "上传任意数量的 TXT，用每行左侧开关控制是否参与抽取，每次只输出一个片段。"

    def pick(self, 文件状态, 分段方式, 抽取方式, seed):
        selected = _expand_file_list(_enabled_file_list(文件状态))
        if not selected:
            raise ValueError("没有已启用且可读取的 TXT。请上传文件并打开左侧开关。")

        available: list[tuple[str, list[str]]] = []
        for option, path in selected:
            segments = _segments(path, 分段方式)
            if segments:
                available.append((option, segments))

        if not available:
            raise ValueError("所选 TXT 没有可抽取的内容。")

        ordered_rng = random.Random(seed ^ 0x5A17C9E3)
        ordered_text = "\n".join(
            segments[ordered_rng.randrange(len(segments))]
            for _, segments in available
        )

        rng = random.Random(seed)
        if 抽取方式 == "每个文件等概率":
            source, segments = rng.choice(available)
            index = rng.randrange(len(segments))
            return (segments[index], source, index + 1, ordered_text)

        pool: list[tuple[str, int, str]] = []
        for source, segments in available:
            pool.extend((source, index + 1, text) for index, text in enumerate(segments))
        source, index, text = rng.choice(pool)
        return (text, source, index, ordered_text)

    @classmethod
    def IS_CHANGED(cls, 文件状态, 分段方式, 抽取方式, seed):
        state = [str(seed), 分段方式, 抽取方式, 文件状态]
        for option, path in _expand_file_list(_enabled_file_list(文件状态)):
            stat = path.stat()
            state.extend((option, str(stat.st_mtime_ns), str(stat.st_size)))
        return hashlib.sha256("|".join(state).encode("utf-8")).hexdigest()


NODE_CLASS_MAPPINGS = {
    "OneSegmentWildcardPicker": OneSegmentWildcardPicker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OneSegmentWildcardPicker": "多TXT只抽一段（通配符）",
}


# 在 ComfyUI 环境中注册 TXT 拖放上传接口。独立测试时没有 server 模块，会安全跳过。
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/one_segment_wildcard/upload_txt")
    async def upload_txt(request):
        form = await request.post()
        uploaded = form.get("file")
        if uploaded is None or not getattr(uploaded, "filename", None):
            return web.json_response({"error": "没有收到文件"}, status=400)

        filename = Path(uploaded.filename).name
        if Path(filename).suffix.lower() != ".txt":
            return web.json_response({"error": "只支持 TXT 文件"}, status=400)

        content = uploaded.file.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            return web.json_response({"error": "TXT 文件不能超过 20 MB"}, status=413)

        upload_dir = LOCAL_WILDCARDS / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        destination = upload_dir / filename
        destination.write_bytes(content)
        return web.json_response(
            {"path": f"本节点/uploads/{filename}", "size": len(content)}
        )

    @PromptServer.instance.routes.post("/one_segment_wildcard/delete_uploads")
    async def delete_uploads(request):
        payload = await request.json()
        labels = payload.get("paths", [])
        if not isinstance(labels, list):
            return web.json_response({"error": "paths 必须是列表"}, status=400)

        return web.json_response(_delete_uploaded_paths(labels))

    @PromptServer.instance.routes.get("/one_segment_wildcard/list_uploads")
    async def list_uploads(request):
        return web.json_response({"paths": _uploaded_file_labels()})
except (ImportError, AttributeError):
    pass
