import type { Terminal, ITerminalAddon, IDisposable } from "xterm";
import ansiRegex from "./ansi-regex";

import { HistoryController } from "./HistoryController";
import {
  closestLeftBoundary,
  closestRightBoundary,
  collectAutocompleteCandidates,
  countLines,
  getLastToken,
  hasTailingWhitespace,
  isIncompleteInput,
  offsetToColRow,
  getSharedFragment,
} from "./Utils";

interface Size {
  cols: number;
  rows: number;
}

interface ActivePrompt {
  prompt: string;
  continuationPrompt?: string;
  resolve: any;
  reject: any;
}

interface AutoCompleteHandler {
  fn: Function;
  args: any[];
}

export interface Option {
  historySize: number;
  maxAutocompleteEntries: number;
}

export class LocalEchoAddon implements ITerminalAddon {
  constructor(
    options: Option = {
      historySize: 10,
      maxAutocompleteEntries: 100,
    }
  ) {
    this.history = new HistoryController(options.historySize);
    this.maxAutocompleteEntries = options.maxAutocompleteEntries;
  }

  public history: HistoryController;

  private terminal!: Terminal;
  private disposables: IDisposable[] = [];

  private maxAutocompleteEntries: number;

  private autocompleteHandlers: AutoCompleteHandler[] = [];
  private active = false;
  private input = "";
  private cursor = 0;
  private activePrompt: ActivePrompt | null = null;
  private activeCharPrompt: ActivePrompt | null = null;

  private terminalSize: Size = {
    cols: 0,
    rows: 0,
  };

  public activate(terminal: Terminal): void {
    this.terminal = terminal;
    this.attach();
  }

  public dispose(): void {
    this.detach();
  }

  /**
   * Register a handler that will be called to satisfy auto-completion
   */
  public addAutocompleteHandler(fn: Function, ...args: any[]) {
    this.autocompleteHandlers.push({
      fn,
      args,
    });
  }

  /**
   * Remove a previously registered auto-complete handler
   */
  public removeAutocompleteHandler(fn: Function) {
    const idx = this.autocompleteHandlers.findIndex((e) => e.fn === fn);
    if (idx === -1) return;

    this.autocompleteHandlers.splice(idx, 1);
  }

  /**
   * Return a promise that will resolve when the user has completed
   * typing a single line
   */
  public async read(prompt: string, continuationPrompt = "> ") {
    return new Promise((resolve, reject) => {
      this.terminal.write(prompt);
      this.activePrompt = {
        prompt,
        continuationPrompt,
        resolve,
        reject,
      };

      this.input = "";
      this.cursor = 0;
      this.active = true;
    });
  }

  /**
   * Return a promise that will be resolved when the user types a single
   * character.
   *
   * This can be active in addition to `.read()` and will be resolved in
   * priority before it.
   */
  readChar(prompt: string) {
    return new Promise((resolve, reject) => {
      this.terminal.write(prompt);
      this.activeCharPrompt = {
        prompt,
        resolve,
        reject,
      };
    });
  }

  /**
   * Abort a pending read operation
   */
  abortRead(reason = "aborted") {
    if (this.activePrompt != null || this.activeCharPrompt != null) {
      this.terminal.write("\r\n");
    }
    if (this.activePrompt != null) {
      this.activePrompt.reject(reason);
      this.activePrompt = null;
    }
    if (this.activeCharPrompt != null) {
      this.activeCharPrompt.reject(reason);
      this.activeCharPrompt = null;
    }
    this.active = false;
  }

  /**
   * Prints a message and changes line
   */
  println(message: string) {
    this.print(message + "\n");
  }

  /**
   * Prints a message and properly handles new-lines
   */
  print(message: string) {
    const normInput = message.replace(/[\r\n]+/g, "\n");
    this.terminal.write(normInput.replace(/\n/g, "\r\n"));
  }

  /**
   * Prints a list of items using a wide-format
   */
  printWide(items: string[], padding = 2) {
    if (items.length == 0) return this.println("");

    // Compute item sizes and matrix row/cols
    const itemWidth =
      items.reduce((width, item) => Math.max(width, item.length), 0) + padding;
    const wideCols = Math.floor(this.terminalSize.cols / itemWidth);
    const wideRows = Math.ceil(items.length / wideCols);

    // Print matrix
    let i = 0;
    for (let row = 0; row < wideRows; ++row) {
      let rowStr = "";

      // Prepare columns
      for (let col = 0; col < wideCols; ++col) {
        if (i < items.length) {
          let item = items[i++];
          item += " ".repeat(itemWidth - item.length);
          rowStr += item;
        }
      }
      this.println(rowStr);
    }
  }

  private attach() {
    if (!this.terminal) return;
    this.disposables.push(
      this.terminal.onData((data) => this.handleTermData(data))
    );
    this.disposables.push(
      this.terminal.onResize((size) => this.handleTermResize(size))
    );

    this.terminalSize = {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  private detach() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /////////////////////////////////////////////////////////////////////////////
  // Internal API
  /////////////////////////////////////////////////////////////////////////////

  /**
   * Apply prompts to the given input
   */
  private applyPrompts(input: string) {
    const prompt = (this.activePrompt || {}).prompt || "";
    const continuationPrompt =
      (this.activePrompt || {}).continuationPrompt || "";

    return prompt + input.replace(/\n/g, "\n" + continuationPrompt);
  }

  /**
   * Advances the `offset` as required in order to accompany the prompt
   * additions to the input.
   */
  private applyPromptOffset(input: string, offset: number) {
    const newInput = this.applyPrompts(input.substr(0, offset));
    return newInput.replace(ansiRegex(), "").length;
  }

  /**
   * Clears the current prompt
   *
   * This function will erase all the lines that display the current prompt
   * and move the cursor in the beginning of the first line of the prompt.
   */
  private clearInput() {
    const currentPrompt = this.applyPrompts(this.input);

    // Get the overall number of lines to clear
    const allRows = countLines(currentPrompt, this.terminalSize.cols);

    // Get the line we are currently in
    const promptCursor = this.applyPromptOffset(this.input, this.cursor);
    const { row } = offsetToColRow(
      currentPrompt,
      promptCursor,
      this.terminalSize.cols
    );

    // First move on the last line
    const moveRows = allRows - row - 1;
    for (let i = 0; i < moveRows; ++i) this.terminal.write("\x1B[E");

    // Clear current input line(s)
    this.terminal.write("\r\x1B[K");
    for (let i = 1; i < allRows; ++i) this.terminal.write("\x1B[F\x1B[K");
  }

  /**
   * Replace input with the new input given
   *
   * This function clears all the lines that the current input occupies and
   * then replaces them with the new input.
   */
  private setInput(newInput: string, clearInput = true) {
    // Clear current input
    if (clearInput) this.clearInput();

    // Write the new input lines, including the current prompt
    const newPrompt = this.applyPrompts(newInput);
    this.print(newPrompt);

    // Trim cursor overflow
    if (this.cursor > newInput.length) {
      this.cursor = newInput.length;
    }

    // Move the cursor to the appropriate row/col
    const newCursor = this.applyPromptOffset(newInput, this.cursor);
    const newLines = countLines(newPrompt, this.terminalSize.cols);
    const { col, row } = offsetToColRow(
      newPrompt,
      newCursor,
      this.terminalSize.cols
    );
    const moveUpRows = newLines - row - 1;

    this.terminal.write("\r");
    for (let i = 0; i < moveUpRows; ++i) this.terminal.write("\x1B[F");
    for (let i = 0; i < col; ++i) this.terminal.write("\x1B[C");

    // Replace input
    this.input = newInput;
  }

  /**
   * This function completes the current input, calls the given callback
   * and then re-displays the prompt.
   */
  private printAndRestartPrompt(callback: any) {
    const cursor = this.cursor;

    // Complete input
    this.setCursor(this.input.length);
    this.terminal.write("\r\n");

    // Prepare a function that will resume prompt
    const resume = () => {
      this.cursor = cursor;
      this.setInput(this.input);
    };

    // Call the given callback to echo something, and if there is a promise
    // returned, wait for the resolution before resuming prompt.
    const ret = callback();
    if (ret == null) {
      resume();
    } else {
      ret.then(resume);
    }
  }

  /**
   * Set the new cursor position, as an offset on the input string
   *
   * This function:
   * - Calculates the previous and current
   */
  private setCursor(newCursor: number) {
    if (newCursor < 0) newCursor = 0;
    if (newCursor > this.input.length) newCursor = this.input.length;

    // Apply prompt formatting to get the visual status of the display
    const inputWithPrompt = this.applyPrompts(this.input);

    // Estimate previous cursor position
    const prevPromptOffset = this.applyPromptOffset(this.input, this.cursor);
    const { col: prevCol, row: prevRow } = offsetToColRow(
      inputWithPrompt,
      prevPromptOffset,
      this.terminalSize.cols
    );

    // Estimate next cursor position
    const newPromptOffset = this.applyPromptOffset(this.input, newCursor);
    const { col: newCol, row: newRow } = offsetToColRow(
      inputWithPrompt,
      newPromptOffset,
      this.terminalSize.cols
    );

    // Adjust vertically
    if (newRow > prevRow) {
      for (let i = prevRow; i < newRow; ++i) this.terminal.write("\x1B[B");
    } else {
      for (let i = newRow; i < prevRow; ++i) this.terminal.write("\x1B[A");
    }

    // Adjust horizontally
    if (newCol > prevCol) {
      for (let i = prevCol; i < newCol; ++i) this.terminal.write("\x1B[C");
    } else {
      for (let i = newCol; i < prevCol; ++i) this.terminal.write("\x1B[D");
    }

    // Set new offset
    this.cursor = newCursor;
  }

  /**
   * Move cursor at given direction
   */
  private handleCursorMove(dir: number) {
    if (dir > 0) {
      const num = Math.min(dir, this.input.length - this.cursor);
      this.setCursor(this.cursor + num);
    } else if (dir < 0) {
      const num = Math.max(dir, -this.cursor);
      this.setCursor(this.cursor + num);
    }
  }

  /**
   * Erase a character at cursor location
   */
  private handleCursorErase(backspace: boolean) {
    if (backspace) {
      if (this.cursor <= 0) return;
      const newInput =
        this.input.substr(0, this.cursor - 1) + this.input.substr(this.cursor);
      this.clearInput();
      this.cursor -= 1;
      this.setInput(newInput, false);
    } else {
      const newInput =
        this.input.substr(0, this.cursor) + this.input.substr(this.cursor + 1);
      this.setInput(newInput);
    }
  }

  /**
   * Insert character at cursor location
   */
  private handleCursorInsert(data: string) {
    const newInput =
      this.input.substr(0, this.cursor) + data + this.input.substr(this.cursor);
    this.cursor += data.length;
    this.setInput(newInput);
  }

  /**
   * Handle input completion
   */
  private handleReadComplete() {
    if (this.history) {
      this.history.push(this.input);
    }
    if (this.activePrompt) {
      this.activePrompt.resolve(this.input);
      this.activePrompt = null;
    }
    this.terminal.write("\r\n");
    this.active = false;
  }

  /**
   * Handle terminal resize
   *
   * This function clears the prompt using the previous configuration,
   * updates the cached terminal size information and then re-renders the
   * input. This leads (most of the times) into a better formatted input.
   */
  private handleTermResize(data: Size) {
    const { rows, cols } = data;
    this.clearInput();
    this.terminalSize = { cols, rows };
    this.setInput(this.input, false);
  }

  /**
   * Handle terminal input
   */
  private handleTermData(data: string) {
    if (!this.active) return;

    // If we have an active character prompt, satisfy it in priority
    if (this.activeCharPrompt != null) {
      this.activeCharPrompt.resolve(data);
      this.activeCharPrompt = null;
      this.terminal.write("\r\n");
      return;
    }

    // If this looks like a pasted input, expand it
    if (data.length > 3 && data.charCodeAt(0) !== 0x1b) {
      const normData = data.replace(/[\r\n]+/g, "\r");
      Array.from(normData).forEach((c) => this.handleData(c));
    } else {
      this.handleData(data);
    }
  }

  /**
   * Handle a single piece of information from the terminal.
   */
  private handleData(data: string) {
    if (!this.active) return;
    const ord = data.charCodeAt(0);
    let ofs;

    // Handle ANSI escape sequences
    if (ord == 0x1b) {
      switch (data.substr(1)) {
        case "[A": // Up arrow
          if (this.history) {
            const value = this.history.getPrevious();
            if (value) {
              this.setInput(value);
              this.setCursor(value.length);
            }
          }
          break;

        case "[B": // Down arrow
          if (this.history) {
            let value = this.history.getNext();
            if (!value) value = "";
            this.setInput(value);
            this.setCursor(value.length);
          }
          break;

        case "[D": // Left Arrow
          this.handleCursorMove(-1);
          break;

        case "[C": // Right Arrow
          this.handleCursorMove(1);
          break;

        case "[3~": // Delete
          this.handleCursorErase(false);
          break;

        case "[F": // End
          this.setCursor(this.input.length);
          break;

        case "[H": // Home
          this.setCursor(0);
          break;

        case "b": // ALT + LEFT
          ofs = closestLeftBoundary(this.input, this.cursor);
          if (ofs != null) this.setCursor(ofs);
          break;

        case "f": // ALT + RIGHT
          ofs = closestRightBoundary(this.input, this.cursor);
          if (ofs != null) this.setCursor(ofs);
          break;

        case "\x7F": // CTRL + BACKSPACE
          ofs = closestLeftBoundary(this.input, this.cursor);
          if (ofs != null) {
            this.setInput(
              this.input.substr(0, ofs) + this.input.substr(this.cursor)
            );
            this.setCursor(ofs);
          }
          break;
      }

      // Handle special characters
    } else if (ord < 32 || ord === 0x7f) {
      switch (data) {
        case "\r": // ENTER
          if (isIncompleteInput(this.input)) {
            this.handleCursorInsert("\n");
          } else {
            this.handleReadComplete();
          }
          break;

        case "\x7F": // BACKSPACE
          this.handleCursorErase(true);
          break;

        case "\t": // TAB
          if (this.autocompleteHandlers.length > 0) {
            const inputFragment = this.input.substr(0, this.cursor);
            const hasTailingSpace = hasTailingWhitespace(inputFragment);
            const candidates = collectAutocompleteCandidates(
              this.autocompleteHandlers,
              inputFragment
            );

            // Sort candidates
            candidates.sort();

            // Depending on the number of candidates, we are handing them in
            // a different way.
            if (candidates.length === 0) {
              // No candidates? Just add a space if there is none already
              if (!hasTailingSpace) {
                this.handleCursorInsert(" ");
              }
            } else if (candidates.length === 1) {
              // Just a single candidate? Complete
              const lastToken = getLastToken(inputFragment);
              this.handleCursorInsert(
                candidates[0].substr(lastToken.length) + " "
              );
            } else if (candidates.length <= this.maxAutocompleteEntries) {
              // search for a shared fragement
              const sameFragment = getSharedFragment(inputFragment, candidates);

              // if there's a shared fragement between the candidates
              // print complete the shared fragment
              if (sameFragment) {
                const lastToken = getLastToken(inputFragment);
                this.handleCursorInsert(sameFragment.substr(lastToken.length));
              }

              // If we are less than maximum auto-complete candidates, print
              // them to the user and re-start prompt
              this.printAndRestartPrompt(() => {
                this.printWide(candidates);
              });
            } else {
              // If we have more than maximum auto-complete candidates, print
              // them only if the user acknowledges a warning
              this.printAndRestartPrompt(() =>
                this.readChar(
                  `Display all ${candidates.length} possibilities? (y or n)`
                ).then((yn) => {
                  if (yn == "y" || yn == "Y") {
                    this.printWide(candidates);
                  }
                })
              );
            }
          } else {
            this.handleCursorInsert("    ");
          }
          break;

        case "\x03": // CTRL+C
          this.setCursor(this.input.length);
          this.terminal.write(
            "^C\r\n" + ((this.activePrompt || {}).prompt || "")
          );
          this.input = "";
          this.cursor = 0;
          if (this.history) this.history.rewind();
          break;
      }

      // Handle visible characters
    } else {
      this.handleCursorInsert(data);
    }
  }
}
