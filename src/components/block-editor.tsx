"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Block } from "@/lib/types";

// ─── Slash commands ─────────────────────────────────────────────────────────

const HIGHLIGHT_COLORS = [
  { color: "#fef08a", label: "Yellow" },
  { color: "#bbf7d0", label: "Green" },
  { color: "#bfdbfe", label: "Blue" },
  { color: "#fbcfe8", label: "Pink" },
];

const HIGHLIGHT_DEFAULT = "#fef08a";

const SLASH_COMMANDS = [
  { command: "/todo", label: "To-do", type: "todo" as const, icon: "☐" },
  { command: "/list", label: "Bullet List", type: "list" as const, icon: "•" },
  { command: "/number", label: "Numbered List", type: "number" as const, icon: "1." },
  { command: "/h1", label: "Heading 1", type: "h1" as const, icon: "H₁" },
  { command: "/h2", label: "Heading 2", type: "h2" as const, icon: "H₂" },
  { command: "/h3", label: "Heading 3", type: "h3" as const, icon: "H₃" },
  { command: "/quote", label: "Quote", type: "quote" as const, icon: "“" },
  { command: "/divider", label: "Divider", type: "divider" as const, icon: "—" },
  { command: "/code", label: "Code", type: "code" as const, icon: "<>" },
  { command: "/text", label: "Text", type: "text" as const, icon: "¶" },
];

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSafeHTML(content: string): string {
  if (!content) return "";
  if (
    content.includes("<sup>") ||
    content.includes("<sub>") ||
    content.includes("<b>") ||
    content.includes("<strong>") ||
    content.includes("<br>") ||
    content.includes("<mark")
  ) {
    return content;
  }
  return escapeHtml(content);
}

function cleanEmptyTags(html: string): string {
  if (!html) return "";
  let cleaned = html.replace(/\u200B/g, "");
  cleaned = cleaned
    .replace(/<sup[^>]*>\s*<\/sup>/gi, "")
    .replace(/<sub[^>]*>\s*<\/sub>/gi, "")
    .replace(/<b[^>]*>\s*<\/b>/gi, "")
    .replace(/<strong[^>]*>\s*<\/strong>/gi, "")
    .replace(/<mark[^>]*>\s*<\/mark>/gi, "");
  return cleaned;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface BlockEditorProps {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
}

export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
  const [mounted, setMounted] = useState(false);
  const [slashMenu, setSlashMenu] = useState<{
    blockId: string;
    query: string;
  } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [selectedMenuIndex, setSelectedMenuIndex] = useState(0);
  const [history, setHistory] = useState<Block[][]>([blocks]);
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; blockId: string } | null>(null);

  const blockRefs = useRef<Record<string, HTMLElement | null>>({});
  const pendingFocusId = useRef<string | null>(null);
  const pendingCaret = useRef<{ blockId: string; offset: number } | null>(null);
  const isUndoRedoing = useRef(false);
  const selectionAnchorRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isShiftSelectingRef = useRef(false);
  const mouseDownBlockIdRef = useRef<string | null>(null);
  const isDragSelectingRef = useRef(false);

  useEffect(() => setMounted(true), []);

  const filteredCommands = slashMenu
    ? SLASH_COMMANDS.filter((c) =>
        c.command.startsWith(slashMenu.query.toLowerCase())
      )
    : [];

  // (Menu position is computed inline in handleInput)

  // ─── Focus management ──────────────────────────────────────────────────

  useEffect(() => {
    if (pendingCaret.current) {
      const { blockId, offset } = pendingCaret.current;
      const el = blockRefs.current[blockId];
      pendingCaret.current = null;

      if (el) {
        el.focus();
        const range = document.createRange();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let remaining = offset;
        let textNode = walker.nextNode();

        while (textNode) {
          const length = textNode.textContent?.length ?? 0;
          if (remaining <= length) {
            range.setStart(textNode, remaining);
            range.collapse(true);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
          remaining -= length;
          textNode = walker.nextNode();
        }

        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }

    if (pendingFocusId.current) {
      const el = blockRefs.current[pendingFocusId.current];
      if (el) {
        el.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        if (el.childNodes.length > 0) {
          range.setStartAfter(el.lastChild!);
        } else {
          range.setStart(el, 0);
        }
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      pendingFocusId.current = null;
    }
  });

  // ─── History management ─────────────────────────────────────────────

  const rememberCaret = useCallback((blockId: string) => {
    const el = blockRefs.current[blockId];
    const sel = window.getSelection();
    if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;

    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    pendingCaret.current = { blockId, offset: range.toString().length };
  }, []);

  const pushToHistory = useCallback((newBlocks: Block[]) => {
    if (isUndoRedoing.current) return;
    setHistory((prev) => {
      const next = prev.slice(0, currentHistoryIndex + 1);
      if (JSON.stringify(next[next.length - 1]) === JSON.stringify(newBlocks)) return next;
      // Limit history to 50 steps
      const updated = [...next, newBlocks];
      if (updated.length > 50) updated.shift();
      setCurrentHistoryIndex(updated.length - 1);
      return updated;
    });
  }, [currentHistoryIndex]);

  const undo = useCallback(() => {
    if (currentHistoryIndex > 0) {
      isUndoRedoing.current = true;
      const prev = history[currentHistoryIndex - 1];
      setCurrentHistoryIndex(currentHistoryIndex - 1);
      onChange(prev);
      // Wait for React to update and reset the flag
      setTimeout(() => { isUndoRedoing.current = false; }, 0);
    }
  }, [currentHistoryIndex, history, onChange]);

  const redo = useCallback(() => {
    if (currentHistoryIndex < history.length - 1) {
      isUndoRedoing.current = true;
      const next = history[currentHistoryIndex + 1];
      setCurrentHistoryIndex(currentHistoryIndex + 1);
      onChange(next);
      setTimeout(() => { isUndoRedoing.current = false; }, 0);
    }
  }, [currentHistoryIndex, history, onChange]);

  // Handle outside updates to blocks (like from other cells or initial load)
  useEffect(() => {
    if (!isUndoRedoing.current) {
        setHistory([blocks]);
        setCurrentHistoryIndex(0);
    }
  }, []); // Only on mount

  // ─── Block operations ─────────────────────────────────────────────────

  const updateBlocks = useCallback((newBlocks: Block[]) => {
    pushToHistory(newBlocks);
    onChange(newBlocks);
  }, [pushToHistory, onChange]);

  const updateBlock = useCallback(
    (id: string, updates: Partial<Block>) => {
      updateBlocks(blocks.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    },
    [blocks, updateBlocks]
  );

  const handleBlockSelect = useCallback(
    (id: string, extend: boolean) => {
      if (extend && selectionAnchorRef.current) {
        const anchorIdx = blocks.findIndex((b) => b.id === selectionAnchorRef.current);
        const targetIdx = blocks.findIndex((b) => b.id === id);
        if (anchorIdx !== -1 && targetIdx !== -1) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          setSelectedBlockIds(blocks.slice(start, end + 1).map((b) => b.id));
          return;
        }
      }
      setSelectedBlockIds([id]);
      selectionAnchorRef.current = id;
    },
    [blocks]
  );

  const applyHighlight = useCallback((blockId: string, color: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const el = blockRefs.current[blockId];
    if (!el) return;

    // If already inside a mark, just change its color
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== el) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "MARK") {
        (node as HTMLElement).style.backgroundColor = color;
        updateBlock(blockId, { content: el.innerHTML });
        return;
      }
      node = node.parentNode;
    }

    const mark = document.createElement("mark");
    mark.style.backgroundColor = color;
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    range.selectNodeContents(mark);
    sel.removeAllRanges();
    sel.addRange(range);
    updateBlock(blockId, { content: el.innerHTML });
  }, [updateBlock]);

  const removeHighlight = useCallback((blockId: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const el = blockRefs.current[blockId];
    if (!el) return;

    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== el) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "MARK") {
        const mark = node as HTMLElement;
        const parent = mark.parentNode!;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        updateBlock(blockId, { content: el.innerHTML });
        return;
      }
      node = node.parentNode;
    }
  }, [updateBlock]);

  const toggleBold = useCallback((blockId: string) => {
    const sel = window.getSelection();
    const el = blockRefs.current[blockId];
    if (!sel || sel.rangeCount === 0 || !el) return;

    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;

    document.execCommand("bold");
    updateBlock(blockId, { content: el.innerHTML });
  }, [updateBlock]);

  // Show color toolbar when text is selected inside any block
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { setSelectionToolbar(null); return; }
      const range = sel.getRangeAt(0);
      for (const [id, el] of Object.entries(blockRefs.current)) {
        if (el && el.contains(range.commonAncestorContainer)) {
          const rect = range.getBoundingClientRect();
          if (rect.width > 0) {
            setSelectionToolbar({ x: rect.left + rect.width / 2, y: rect.top, blockId: id });
          }
          return;
        }
      }
      setSelectionToolbar(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // Clean up drag-select on mouseup
  useEffect(() => {
    const onMouseUp = () => {
      mouseDownBlockIdRef.current = null;
      if (isDragSelectingRef.current) {
        isDragSelectingRef.current = false;
        if (containerRef.current) containerRef.current.style.userSelect = "";
        containerRef.current?.focus();
      }
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  const addBlockAfter = useCallback(
    (afterId: string, type: Block["type"] = "text") => {
      const newBlock: Block = { id: generateId(), type, content: "" };
      const idx = blocks.findIndex((b) => b.id === afterId);
      const updated = [...blocks];
      updated.splice(idx + 1, 0, newBlock);
      updateBlocks(updated);
      pendingFocusId.current = newBlock.id;
    },
    [blocks, updateBlocks]
  );

  const addBlockBefore = useCallback(
    (beforeId: string, type: Block["type"] = "text") => {
      const newBlock: Block = { id: generateId(), type, content: "" };
      const idx = blocks.findIndex((b) => b.id === beforeId);
      const updated = [...blocks];
      updated.splice(idx, 0, newBlock);
      updateBlocks(updated);
      pendingFocusId.current = newBlock.id;
    },
    [blocks, updateBlocks]
  );

  const deleteBlock = useCallback(
    (id: string) => {
      if (blocks.length <= 1) return;
      const idx = blocks.findIndex((b) => b.id === id);
      const updated = blocks.filter((b) => b.id !== id);
      updateBlocks(updated);
      const prev = updated[Math.max(0, idx - 1)];
      if (prev) pendingFocusId.current = prev.id;
    },
    [blocks, updateBlocks]
  );

  const applySlashCommand = useCallback(
    (blockId: string, cmd: (typeof SLASH_COMMANDS)[0]) => {
      const el = blockRefs.current[blockId];
      if (el) el.textContent = "";

      updateBlock(blockId, {
        type: cmd.type,
        content: "",
        ...(cmd.type === "todo" ? { checked: false } : {}),
      });
      setSlashMenu(null);
      pendingFocusId.current = blockId;
    },
    [updateBlock]
  );

  // ─── Event handlers ──────────────────────────────────────────────────

  const handlePaste = useCallback(
    (id: string, e: React.ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain") || e.clipboardData.getData("text") || "";
      if (!text) return;

      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      if (lines.length === 0) return;

      // Single plain line with no markdown indicators: insert at cursor as plain text
      if (
        lines.length === 1 &&
        !lines[0].match(/^([-*] |[0-9]+\. |- ?\[[ xX]?\]\s|# |> )/)
      ) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const textNode = document.createTextNode(lines[0]);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        const el = blockRefs.current[id];
        if (el) updateBlock(id, { content: el.innerHTML });
        return;
      }

      // Multi-line or markdown paste: split into blocks
      {
        const idx = blocks.findIndex((b) => b.id === id);
        const currentBlock = blocks[idx];
        const newBlocks: Block[] = [];

        lines.forEach((originalLine) => {
          let type: Block["type"] = "text";
          const line = originalLine.trim();
          let content = line;
          let checked = false;

          if (line.match(/^-\s*\[[ xX]?\]\s/)) {
            type = "todo";
            content = line.replace(/^-\s*\[[ xX]?\]\s*/, "");
            checked = /\[x\]/i.test(line);
          } else if (line.match(/^[-*]\s+/)) {
            type = "list";
            content = line.replace(/^[-*]\s+/, "");
          } else if (line.match(/^[0-9]+\. /)) {
            type = "number";
            content = line.replace(/^[0-9]+\. /, "");
          } else if (line.startsWith("# ")) {
            type = "h1";
            content = line.substring(2);
          } else if (line.startsWith("## ")) {
            type = "h2";
            content = line.substring(3);
          } else if (line.startsWith("### ")) {
            type = "h3";
            content = line.substring(4);
          } else if (line.startsWith("> ")) {
            type = "quote";
            content = line.substring(2);
          }

          newBlocks.push({
            id: generateId(),
            type,
            content: content.trim(),
            ...(type === "todo" ? { checked } : {}),
          });
        });

        const updated = [...blocks];
        // If current block is empty text, replace it. Otherwise insert after.
        if (currentBlock.content === "" && currentBlock.type === "text") {
          updated.splice(idx, 1, ...newBlocks);
        } else {
          updated.splice(idx + 1, 0, ...newBlocks);
        }

        updateBlocks(updated);

        // Clear refs for the replaced/new blocks so they re-init with correct textContent
        newBlocks.forEach((nb) => {
          if (blockRefs.current[nb.id]) {
            blockRefs.current[nb.id]!.dataset.init = "";
          }
        });

        pendingFocusId.current = newBlocks[newBlocks.length - 1].id;
      }
    },
    [blocks, updateBlocks, updateBlock]
  );

  const handleInput = useCallback(
    (id: string, e: React.FormEvent<HTMLElement>) => {
      const el = e.target as HTMLElement;
      const rawText = el.textContent || "";
      const text = rawText.replace(/\u00a0/g, " ").replace(/\u200b/g, "");

      let html = el.innerHTML || "";
      
      // If there's no actual text and no formatting tags, clean it up as empty string
      if (text === "" && !html.includes("<sup") && !html.includes("<sub")) {
        html = "";
      }

      updateBlock(id, { content: html });

      const slashMatch = text.match(/\/(\S*)$/);
      if (slashMatch) {
        // Capture caret position NOW, while selection is still valid
        let pos = { x: 0, y: 0 };
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.height > 0) {
            pos = { x: rect.left, y: rect.bottom + 4 };
          } else {
            // Collapsed caret fallback: use block element
            const el = blockRefs.current[id];
            if (el) {
              const blockRect = el.getBoundingClientRect();
              pos = { x: blockRect.left, y: blockRect.bottom + 4 };
            }
          }
        }
        setMenuPos(pos);
        setSlashMenu({ blockId: id, query: "/" + slashMatch[1] });

        setSelectedMenuIndex(0);
      } else {
        setSlashMenu(null);
        setMenuPos(null);
      }
    },
    [updateBlock]
  );

  const handleKeyDown = useCallback(
    (id: string, e: KeyboardEvent<HTMLElement>) => {
      const block = blocks.find((b) => b.id === id);
      if (!block) return;

      // Slash menu navigation
      if (slashMenu && slashMenu.blockId === id) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedMenuIndex((i) =>
            Math.min(i + 1, filteredCommands.length - 1)
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedMenuIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (filteredCommands.length > 0) {
            e.preventDefault();
            applySlashCommand(id, filteredCommands[selectedMenuIndex]);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenu(null);
          return;
        }
      }

      // Subscript / Superscript navigation and toggles
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        let parent: Node | null = sel.anchorNode;
        let insideInlineTag = false;
        let inlineElement: HTMLElement | null = null;
        let inlineTagType: "sup" | "sub" | null = null;

        while (parent && parent !== e.currentTarget) {
          if (parent.nodeType === Node.ELEMENT_NODE) {
            const tagName = (parent as HTMLElement).tagName.toLowerCase();
            if (tagName === "sup" || tagName === "sub") {
              insideInlineTag = true;
              inlineElement = parent as HTMLElement;
              inlineTagType = tagName as "sup" | "sub";
              break;
            }
          }
          parent = parent.parentNode;
        }

        // 1. Toggles: ^ and _
        if (e.key === "^" || e.key === "_") {
          e.preventDefault();
          const targetTag = e.key === "^" ? "sup" : "sub";

          if (insideInlineTag && inlineElement && inlineTagType === targetTag) {
            // Exit current tag
            const nextSibling = inlineElement.nextSibling;
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              range.setStart(nextSibling, 0);
            } else {
              const emptyText = document.createTextNode("");
              inlineElement.parentNode?.insertBefore(emptyText, nextSibling);
              range.setStart(emptyText, 0);
            }
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            // Exit previous tag first if it is the other type
            if (insideInlineTag && inlineElement) {
              const nextSibling = inlineElement.nextSibling;
              if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
                range.setStart(nextSibling, 0);
              } else {
                const emptyText = document.createTextNode("");
                inlineElement.parentNode?.insertBefore(emptyText, nextSibling);
                range.setStart(emptyText, 0);
              }
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }

            // Create and insert new tag
            const elem = document.createElement(targetTag);
            elem.appendChild(document.createTextNode("\u200B")); // zero-width space
            range.deleteContents();
            range.insertNode(elem);

            // Position selection inside the tag (after zero-width space)
            range.setStart(elem.firstChild!, 1);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          updateBlock(id, { content: e.currentTarget.innerHTML });
          return;
        }

        // 2. Exiting via Space
        if (e.key === " ") {
          if (insideInlineTag && inlineElement) {
            e.preventDefault();
            const nextSibling = inlineElement.nextSibling;
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              const txt = nextSibling as Text;
              txt.insertData(0, " ");
              range.setStart(txt, 1);
            } else {
              const spaceNode = document.createTextNode(" ");
              inlineElement.parentNode?.insertBefore(spaceNode, nextSibling);
              range.setStart(spaceNode, 1);
            }
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            updateBlock(id, { content: e.currentTarget.innerHTML });
            return;
          }
        }

        // 3. Exiting via ArrowRight
        if (e.key === "ArrowRight") {
          if (insideInlineTag && inlineElement) {
            const textLength = sel.anchorNode?.textContent?.length || 0;
            if (sel.anchorOffset === textLength) {
              e.preventDefault();
              const nextSibling = inlineElement.nextSibling;
              if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
                range.setStart(nextSibling, 0);
              } else {
                const emptyText = document.createTextNode("");
                inlineElement.parentNode?.insertBefore(emptyText, nextSibling);
                range.setStart(emptyText, 0);
              }
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
              return;
            }
          }
        }

        // 4. Deleting empty/zero-width space tags via Backspace
        if (e.key === "Backspace") {
          if (insideInlineTag && inlineElement) {
            const text = inlineElement.textContent || "";
            if (text === "" || text === "\u200B") {
              e.preventDefault();
              const parentNode = inlineElement.parentNode;
              const prevSibling = inlineElement.previousSibling;
              if (parentNode) {
                inlineElement.remove();
                if (prevSibling) {
                  if (prevSibling.nodeType === Node.TEXT_NODE) {
                    range.setStart(prevSibling, prevSibling.textContent?.length || 0);
                  } else {
                    range.setStartAfter(prevSibling);
                  }
                } else {
                  range.setStart(parentNode, 0);
                }
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                updateBlock(id, { content: e.currentTarget.innerHTML });
              }
              return;
            }
          }
        }
      }

      // Markdown shortcuts: detect pattern BEFORE Space is inserted
      if (e.key === " ") {
        const el = blockRefs.current[id];
        const rawText = (el?.textContent || "").replace(/\u00a0/g, " ");

        if (block.type === "text") {
          // Todo: - [] or - [ ] or [] or - [x]
          if (/^-\s*\[[ x]?\]$/i.test(rawText) || rawText === "[]") {
            e.preventDefault();
            const checked = /\[x\]/i.test(rawText);
            if (el) { el.textContent = ""; el.dataset.init = ""; }
            updateBlock(id, { type: "todo", content: "", checked });
            return;
          }
          // Bullet list: - or *
          if (rawText === "-" || rawText === "*") {
            e.preventDefault();
            if (el) { el.textContent = ""; el.dataset.init = ""; }
            updateBlock(id, { type: "list", content: "" });
            return;
          }
          // Number: 1.
          if (rawText === "1.") {
            e.preventDefault();
            if (el) { el.textContent = ""; el.dataset.init = ""; }
            updateBlock(id, { type: "number", content: "" });
            return;
          }
          // Heading: #
          if (rawText === "#") {
            e.preventDefault();
            if (el) { el.textContent = ""; el.dataset.init = ""; }
            updateBlock(id, { type: "h1", content: "" });
            return;
          }
          // Quote: >
          if (rawText === ">") {
            e.preventDefault();
            if (el) { el.textContent = ""; el.dataset.init = ""; }
            updateBlock(id, { type: "quote", content: "" });
            return;
          }
        }
      }

      // Select All (Cmd+A)
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        const container = (e.currentTarget as HTMLElement).closest(".space-y-px");
        if (container) {
          const range = document.createRange();
          range.selectNodeContents(container);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          // Focus the container so it can catch the next Delete event
          (container as HTMLElement).focus();
        }
      }

      // Undo (Cmd+Z)
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        rememberCaret(id);
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      // Highlight toggle (Ctrl+H / Cmd+H)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const blockEl = e.currentTarget as HTMLElement;
        let node: Node | null = range.commonAncestorContainer;
        let insideMark: HTMLElement | null = null;
        while (node && node !== blockEl) {
          if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "MARK") {
            insideMark = node as HTMLElement;
            break;
          }
          node = node.parentNode;
        }
        if (insideMark) {
          const parent = insideMark.parentNode!;
          while (insideMark.firstChild) parent.insertBefore(insideMark.firstChild, insideMark);
          parent.removeChild(insideMark);
          updateBlock(id, { content: blockEl.innerHTML });
        } else {
          applyHighlight(id, HIGHLIGHT_DEFAULT);
        }
        return;
      }

      // Bold toggle (Ctrl+B / Cmd+B)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleBold(id);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        
        // Determine if we should continue the current block type
        const continueType = (block.type === "list" || block.type === "number" || block.type === "todo") ? block.type : "text";
        
        // If at start of line, insert BEFORE
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (range.startOffset === 0 && range.endOffset === 0) {
            addBlockBefore(id);
            return;
          }
        }
        
        addBlockAfter(id, continueType);
      }

      // Backspace on empty → downgrade type, then delete
      if (e.key === "Backspace") {
        const el = blockRefs.current[id];
        if ((el?.textContent || "") === "") {
          e.preventDefault();
          if (block.type !== "text") {
            updateBlock(id, { type: "text", checked: undefined });
          } else {
            deleteBlock(id);
          }
        }
      }

      // Arrow key navigation between blocks
      if (e.key === "ArrowUp" && !slashMenu) {
        const idx = blocks.findIndex((b) => b.id === id);
        if (idx > 0) {
          e.preventDefault();
          blockRefs.current[blocks[idx - 1].id]?.focus();
        }
      }
      if (e.key === "ArrowDown" && !slashMenu) {
        const idx = blocks.findIndex((b) => b.id === id);
        if (idx < blocks.length - 1) {
          e.preventDefault();
          blockRefs.current[blocks[idx + 1].id]?.focus();
        }
      }
    },
    [
      blocks,
      slashMenu,
      filteredCommands,
      selectedMenuIndex,
      applySlashCommand,
      addBlockAfter,
      deleteBlock,
      updateBlock,
      applyHighlight,
      toggleBold,
      rememberCaret,
    ]
  );

  // ─── Style helpers ────────────────────────────────────────────────────

  const blockStyle = (type: Block["type"]) => {
    switch (type) {
      case "h1":
        return "text-base font-bold leading-tight";
      case "h2":
        return "text-sm font-semibold leading-tight";
      case "h3":
        return "text-[13px] font-medium leading-tight";
      case "quote":
        return "text-xs italic border-l-2 border-neutral-200 pl-2 text-neutral-600";
      case "code":
        return "text-[10px] font-mono bg-neutral-50 px-1.5 py-1 rounded border border-neutral-100";
      case "divider":
        return "h-px bg-neutral-200 my-2";
      case "list":
        return "text-xs leading-relaxed";
      default:
        return "text-xs leading-relaxed";
    }
  };

  const placeholderText = (type: Block["type"]) => {
    switch (type) {
      case "todo":
        return "To-do";
      case "number":
        return "Step";
      case "list":
        return "List item";
      case "h1":
        return "Heading 1";
      case "h2":
        return "Heading 2";
      case "h3":
        return "Heading 3";
      case "quote":
        return "Quote";
      case "code":
        return "Code";
      case "divider":
        return "";
      default:
        return "Type / for commands";
    }
  };

  // ─── SSR fallback ─────────────────────────────────────────────────────

  if (!mounted) {
    return (
      <div className="space-y-px">
        {blocks.map((block) => (
          <div
            key={block.id}
            className={`py-px ${blockStyle(block.type)} text-neutral-300`}
            dangerouslySetInnerHTML={{
              __html:
                getSafeHTML(block.content) ||
                (block.type === "text" ? "" : placeholderText(block.type)),
            }}
          />
        ))}
      </div>
    );
  }

  // ─── Main render ──────────────────────────────────────────────────────

  return (
    <>
      <div
        ref={containerRef}
        className="space-y-px outline-none select-text"
        tabIndex={-1}
        onKeyDown={(e) => {
          // Handle selected blocks
          if (selectedBlockIds.length > 0) {
            if (e.key === "Escape") {
              setSelectedBlockIds([]);
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "c") {
              const ordered = blocks.filter((b) => selectedBlockIds.includes(b.id));
              const text = ordered.map((b) => {
                const prefix =
                  b.type === "todo" ? `- [${b.checked ? "x" : " "}] ` :
                  b.type === "list" ? "- " :
                  b.type === "number" ? `${blocks.filter((x, i) => x.type === "number" && i <= blocks.indexOf(b)).length}. ` :
                  b.type === "h1" ? "# " :
                  b.type === "h2" ? "## " :
                  b.type === "h3" ? "### " :
                  b.type === "quote" ? "> " :
                  b.type === "divider" ? "---" : "";
                const tmp = document.createElement("div");
                tmp.innerHTML = b.content;
                return prefix + (b.type === "divider" ? "" : (tmp.textContent || ""));
              }).join("\n");
              navigator.clipboard.writeText(text);
              return;
            }
            if ((e.key === "Backspace" || e.key === "Delete") && e.target === e.currentTarget) {
              e.preventDefault();
              const remaining = blocks.filter((b) => !selectedBlockIds.includes(b.id));
              const newBlocks = remaining.length > 0 ? remaining : [{ id: generateId(), type: "text" as const, content: "" }];
              updateBlocks(newBlocks);
              setSelectedBlockIds([]);
              pendingFocusId.current = newBlocks[0].id;
              return;
            }
          }

          if (e.key === "Backspace" || e.key === "Delete") {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) {
              if (sel.anchorNode !== sel.focusNode || e.target === e.currentTarget) {
                e.preventDefault();
                const firstBlockId = generateId();
                updateBlocks([{ id: firstBlockId, type: "text", content: "" }]);
                pendingFocusId.current = firstBlockId;
              }
            }
          }
        }}
      >
        {blocks.map((block) => (
          <div
            key={block.id}
            className={`relative flex items-start gap-1.5 group/block cursor-text rounded-[2px] ${
              selectedBlockIds.includes(block.id) ? "bg-blue-50 ring-1 ring-blue-100" : ""
            }`}
            onMouseDown={(e) => {
              mouseDownBlockIdRef.current = block.id;
              if (e.shiftKey) {
                e.preventDefault();
                isShiftSelectingRef.current = true;
                handleBlockSelect(block.id, true);
                containerRef.current?.focus();
              } else {
                isShiftSelectingRef.current = false;
                selectionAnchorRef.current = block.id;
                if (selectedBlockIds.length > 0) {
                  setSelectedBlockIds([]);
                }
              }
            }}
            onMouseEnter={(e) => {
              if (
                e.buttons === 1 &&
                mouseDownBlockIdRef.current &&
                mouseDownBlockIdRef.current !== block.id
              ) {
                if (!isDragSelectingRef.current) {
                  isDragSelectingRef.current = true;
                  window.getSelection()?.removeAllRanges();
                  if (containerRef.current) containerRef.current.style.userSelect = "none";
                }
                handleBlockSelect(block.id, true);
              }
            }}
          >
            {/* Visual indicators for lists */}
            {block.type === "todo" && (
              <input
                type="checkbox"
                checked={block.checked || false}
                onChange={(e) =>
                  updateBlock(block.id, { checked: e.target.checked })
                }
                className="mt-[3px] h-3.5 w-3.5 rounded border-neutral-300 accent-neutral-900 cursor-pointer shrink-0"
              />
            )}
            {block.type === "number" && (
              <div className="mt-[3px] text-[10px] font-bold text-neutral-900 shrink-0 min-w-[14px]">
                {blocks.filter((b, i) => b.type === "number" && i <= blocks.indexOf(block)).length}.
              </div>
            )}
            {block.type === "list" && (
              <div className="mt-[3px] text-[10px] text-neutral-500 shrink-0 min-w-[14px] text-center">
                •
              </div>
            )}

            <div className={`flex-1 relative min-w-0 ${block.type === "divider" ? "invisible pointer-events-none" : ""}`}>
              {/* Only show contentEditable if NOT a divider */}
              {block.type !== "divider" && (
                <div
                  ref={(el) => {
                    blockRefs.current[block.id] = el;
                    if (el) {
                      const isFocused = document.activeElement === el;
                      const needsUpdate = !el.dataset.init || 
                        (isUndoRedoing.current && el.innerHTML !== block.content) ||
                        (!isFocused && el.innerHTML !== block.content);
                      
                      if (needsUpdate) {
                        el.dataset.init = "1";
                        el.innerHTML = getSafeHTML(block.content);
                      }
                    }
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  className={`outline-none py-px min-h-[1.3em] ${blockStyle(
                    block.type
                  )} ${
                    block.type === "todo" && block.checked
                      ? "line-through text-neutral-400"
                      : "text-neutral-800"
                  }`}
                  onInput={(e) => handleInput(block.id, e)}
                  onKeyDown={(e) => handleKeyDown(block.id, e)}
                  onPaste={(e) => handlePaste(block.id, e)}
                  onFocus={() => {
                    setFocusedId(block.id);
                    if (!isShiftSelectingRef.current) {
                      setSelectedBlockIds([]);
                    }
                    isShiftSelectingRef.current = false;
                    if (slashMenu && slashMenu.blockId !== block.id)
                      setSlashMenu(null);
                  }}
                  onBlur={(e) => {
                    setFocusedId(null);
                    const el = e.currentTarget;
                    const cleanedHtml = cleanEmptyTags(el.innerHTML);
                    if (cleanedHtml !== el.innerHTML) {
                      el.innerHTML = cleanedHtml;
                      updateBlock(block.id, { content: cleanedHtml });
                    }
                  }}
                />
              )}

              {/* Divider line */}
              {block.type === "divider" && (
                <div className="absolute inset-0 flex items-center pointer-events-auto cursor-default" onClick={() => deleteBlock(block.id)}>
                   <div className="w-full h-px bg-neutral-200" />
                </div>
              )}

              {/* Placeholder overlay */}
              {!block.content &&
                block.type !== "divider" &&
                (block.type !== "text" || focusedId === block.id) && (
                <div className="absolute inset-0 pointer-events-none text-neutral-300 py-px text-xs select-none">
                  {placeholderText(block.type)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Slash command dropdown — rendered via portal at document body level
          so it's never clipped by overflow:hidden on parent cells */}
      {slashMenu &&
        menuPos &&
        filteredCommands.length > 0 &&
        createPortal(
          <div
            className="fixed w-48 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
            style={{
              left: menuPos.x,
              top: menuPos.y,
              zIndex: 9999,
            }}
          >
            <div className="px-3 py-1 text-[9px] uppercase tracking-widest text-neutral-400 font-medium">
              Blocks
            </div>
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.command}
                className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 ${
                  i === selectedMenuIndex
                    ? "bg-neutral-100"
                    : "hover:bg-neutral-50"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySlashCommand(slashMenu.blockId, cmd);
                }}
                onMouseEnter={() => setSelectedMenuIndex(i)}
              >
                <span className="text-neutral-400 text-[11px] w-5 text-center shrink-0">
                  {cmd.icon}
                </span>
                <span className="text-neutral-700">{cmd.label}</span>
                <span className="ml-auto text-neutral-300 text-[10px] font-mono">
                  {cmd.command}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}

      {/* Highlight color toolbar — floats above text selection */}
      {selectionToolbar &&
        mounted &&
        createPortal(
          <div
            className="fixed flex items-center gap-0.5 p-1 rounded-lg bg-white border border-neutral-200 shadow-lg"
            style={{
              left: selectionToolbar.x,
              top: selectionToolbar.y - 8,
              transform: "translateX(-50%) translateY(-100%)",
              zIndex: 9999,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {HIGHLIGHT_COLORS.map(({ color, label }) => (
              <button
                key={color}
                title={label}
                className="w-5 h-5 rounded-sm border border-transparent hover:scale-110 transition-transform"
                style={{ backgroundColor: color }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyHighlight(selectionToolbar.blockId, color);
                }}
              />
            ))}
            <button
              type="button"
              title="Unhighlight"
              aria-label="Unhighlight"
              className="h-5 w-5 rounded-sm border border-neutral-200 bg-white hover:scale-110 transition-transform"
              onMouseDown={(e) => {
                e.preventDefault();
                removeHighlight(selectionToolbar.blockId);
              }}
            />
            <button
              type="button"
              title="Bold"
              aria-label="Bold"
              className="h-5 w-5 rounded-sm bg-white text-xs font-bold text-neutral-700 hover:bg-neutral-50 hover:text-neutral-950 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                toggleBold(selectionToolbar.blockId);
              }}
            >
              B
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
