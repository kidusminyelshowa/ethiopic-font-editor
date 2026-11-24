import { beforeEach, describe, expect, it } from "vitest";
import { actionFor, comboOf, isFreedDefault, keysFor, resetBindings, setBinding } from "./shortcuts";

const press = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  comboOf({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("shortcuts", () => {
  beforeEach(() => resetBindings());

  it("reads key presses the same on every layout", () => {
    expect(press("KeyO", "O", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+O");
    expect(press("Digit1", "!", { shiftKey: true })).toBe("Shift+1");
    expect(press("KeyV", "v", { metaKey: true })).toBe("Ctrl+V");
    expect(press("PageDown", "PageDown")).toBe("PageDown");
    expect(press("ShiftLeft", "Shift", { shiftKey: true })).toBe("");
  });

  it("rebinds, takes the keys from whoever had them, and frees the old default", () => {
    expect(actionFor("K")).toBe("tool.knife");
    expect(setBinding("tool.knife", "Shift+K")).toBeNull();
    expect(actionFor("Shift+K")).toBe("tool.knife");
    expect(actionFor("K")).toBeNull();
    expect(isFreedDefault("K")).toBe(true);
    // Giving the pen's key to the knife unbinds the pen.
    expect(setBinding("tool.knife", "P")).toBe("Pen");
    expect(keysFor("tool.pen")).toBe("");
    resetBindings();
    expect(keysFor("tool.pen")).toBe("P");
  });
});
