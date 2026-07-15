import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";


const CLASS_NAME = "JoinStringMultiTextBox";
const BASE_WIDGET_COUNT = 6;
const MIN_INPUTS = 2;
const MAX_INPUTS = 1000;
const DYNAMIC_WIDGET = Symbol("joinStringMultiTextBoxDynamic");
const TEXT_CONFIG = [
    "STRING",
    {
        default: "",
        multiline: true,
        dynamicPrompts: false,
    },
];


function clampInputCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return MIN_INPUTS;
    return Math.max(MIN_INPUTS, Math.min(MAX_INPUTS, Math.trunc(numeric)));
}


function installDynamicTextBoxes(node) {
    const countWidget = node.widgets?.find((widget) => widget.name === "inputcount");
    const stateWidget = node.widgets?.find((widget) => widget.name === "values_json");
    if (!countWidget || !stateWidget) return;

    const cachedValues = new Map();

    stateWidget.type = "hidden";
    stateWidget.computeSize = () => [0, 0];
    stateWidget.draw = () => {};
    if (stateWidget.inputEl) stateWidget.inputEl.style.display = "none";

    function readSerializedValues(value) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch (_error) {
            return null;
        }
    }

    function collectValues() {
        const count = clampInputCount(countWidget.value);
        const values = [];
        for (let index = 1; index <= count; index++) {
            const widget = node.widgets?.find((item) => item.name === `string_${index}`);
            values.push(String(widget?.value ?? ""));
        }
        return values;
    }

    function writeSerializedValues() {
        stateWidget.value = JSON.stringify(collectValues());
        return stateWidget.value;
    }

    stateWidget.serializeValue = writeSerializedValues;

    function dynamicWidgets() {
        return (node.widgets || []).filter((widget) => widget[DYNAMIC_WIDGET]);
    }

    function addTextBox(index) {
        const name = `string_${index}`;
        const result = ComfyWidgets.STRING(node, name, TEXT_CONFIG, app);
        const widget = result?.widget;
        if (!widget) return null;
        widget[DYNAMIC_WIDGET] = true;
        if (cachedValues.has(name)) widget.value = cachedValues.get(name);
        return widget;
    }

    function removeTextBox(widget) {
        cachedValues.set(widget.name, widget.value ?? "");
        widget.onRemove?.();
        widget.inputEl?.remove?.();
        const index = node.widgets?.indexOf(widget) ?? -1;
        if (index >= 0) node.widgets.splice(index, 1);
    }

    function syncTextBoxes(requestedCount) {
        const count = clampInputCount(requestedCount);
        countWidget.value = count;

        for (const widget of dynamicWidgets()) {
            const index = Number(widget.name.slice("string_".length));
            if (!Number.isInteger(index) || index > count) removeTextBox(widget);
        }

        const existing = new Set((node.widgets || []).map((widget) => widget.name));
        for (let index = 3; index <= count; index++) {
            const name = `string_${index}`;
            if (!existing.has(name) && addTextBox(index)) existing.add(name);
        }

        const size = node.computeSize?.();
        if (size) {
            node.setSize([
                Math.max(node.size?.[0] || 0, size[0]),
                size[1],
            ]);
        }
        writeSerializedValues();
        app.graph?.setDirtyCanvas(true, true);
    }

    const oldCountCallback = countWidget.callback;
    countWidget.callback = function (value) {
        const result = oldCountCallback?.apply(this, arguments);
        syncTextBoxes(value);
        return result;
    };

    const oldConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        const savedValues = Array.isArray(info?.widgets_values)
            ? [...info.widgets_values]
            : null;
        const result = oldConfigure?.apply(this, arguments);
        syncTextBoxes(countWidget.value);

        const serializedValues = readSerializedValues(savedValues?.[5]);
        if (serializedValues?.length >= MIN_INPUTS) {
            for (let index = 1; index <= clampInputCount(countWidget.value); index++) {
                const widget = this.widgets?.find((item) => item.name === `string_${index}`);
                if (widget) widget.value = serializedValues[index - 1] ?? "";
            }
        } else if (savedValues?.length > BASE_WIDGET_COUNT - 1) {
            // 旧版工作流没有 values_json，string_3 从 widgets_values[5] 开始。
            for (let index = 3; index <= clampInputCount(countWidget.value); index++) {
                const widget = this.widgets?.find((item) => item.name === `string_${index}`);
                if (widget && index + 2 < savedValues.length) {
                    widget.value = savedValues[index + 2] ?? "";
                }
            }
        }
        writeSerializedValues();
        return result;
    };

    syncTextBoxes(countWidget.value);
}


app.registerExtension({
    name: "OneSegmentWildcard.JoinStringMultiTextBox",
    nodeCreated(node) {
        if (node.comfyClass === CLASS_NAME) installDynamicTextBoxes(node);
    },
});
