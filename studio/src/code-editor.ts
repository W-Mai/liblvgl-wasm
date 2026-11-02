import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

export interface CodeEditor {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  reveal(line: number, column?: number): void;
}

export function createCodeEditor(
  parent: HTMLElement,
  initialValue: string,
  onChange: () => void,
  onRun: () => void,
): CodeEditor {
  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      basicSetup,
      javascript(),
      EditorView.lineWrapping,
      keymap.of([
        indentWithTab,
        { key: "Mod-Enter", run: () => { onRun(); return true; } },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }),
    focus: () => view.contentDOM.focus({ preventScroll: true }),
    reveal: (line, column = 1) => {
      const info = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      const position = Math.max(info.from, Math.min(info.to, info.from + Math.max(0, column - 1)));
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
      view.focus();
    },
  };
}
