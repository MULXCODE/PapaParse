import {
  isFunction,
  escapeRegExp,
  extend,
  whitelist,
  blacklist,
  isIn
} from "./utils";

// @TODO: Link this to global Papa.config
const BAD_DELIMITERS: string[] = [];
const LINE_ENDINGS: string[] = ["\n", "\r", "\r\n"];
const PARSER_DEFAULTS: ParserConfig = {
  quoteChar: '"',
  delimiter: ",",
  newline: "\r\n",
  comments: false
};

export default class Parser {
  /**
   * Current row that the parser is on
   */
  public cursor: number = 0;

  /**
   * Tracking whether the user has called abort()
   */
  public aborted: boolean = false;

  /**
   * Configuration instance for this parser
   */
  private config: ParserConfig;

  fastMode: boolean;

  constructor(userConfig: Partial<ParserConfig> = {}) {
    let config = extend(PARSER_DEFAULTS, userConfig);

    let { newline, delimiter, quoteChar, escapeChar, comments } = config;

    comments = comments === true ? "#" : comments;
    comments = typeof comments !== "string" ? false : comments;

    // Comment character must be valid
    if (comments === delimiter) {
      throw new Error("Comment character same as delimiter");
    }

    this.config = {
      ...config,
      ...{ escapeChar: escapeChar || quoteChar },
      ...whitelist({ newline }, LINE_ENDINGS, "\r\n"),
      ...blacklist({ delimiter }, BAD_DELIMITERS, ","),
      ...blacklist({ comments }, BAD_DELIMITERS, false)
    };
  }

  parse(input: string, baseIndex: number, ignoreLastRow: boolean) {
    // For some reason, in Chrome, this speeds things up (!?)
    // @TODO investigate this
    if (typeof input !== "string") throw new Error("Input must be a string");

    const {
      delimiter,
      newline,
      comments,
      quoteChar,
      escapeChar,
      fastMode,
      preview
    } = this.config;

    // We don't need to compute some of these every time parse() is called,
    // but having them in a more local scope seems to perform better
    // @TODO investigate this
    const inputLen: number = input.length,
      delimLen: number = delimiter.length,
      newlineLen: number = newline.length,
      commentsLen: number = typeof comments === "string" ? comments.length : 0;

    const stepIsFunction = isFunction(this.config.step);

    // Establish starting state
    this.cursor = 0;
    let data = [],
      errors = [],
      row = [],
      lastCursor = 0;

    if (!input) return this.returnable();

    if (fastMode || (fastMode !== false && !isIn(input, quoteChar))) {
      return this.parseFast(input, ignoreLastRow);
    }

    let nextDelim = input.indexOf(delimiter, this.cursor);
    let nextNewline = input.indexOf(newline, this.cursor);
    const quoteCharRegex = new RegExp(
      escapeRegExp(escapeChar) + escapeRegExp(quoteChar),
      "g"
    );
    let quoteSearch = input.indexOf(quoteChar, this.cursor);

    // Parser loop
    for (;;) {
      // Field has opening quote
      if (input[this.cursor] === quoteChar) {
        // Start our search for the closing quote where the cursor is
        quoteSearch = this.cursor;

        // Skip the opening quote
        this.cursor++;

        for (;;) {
          // Find closing quote
          quoteSearch = input.indexOf(quoteChar, quoteSearch + 1);

          //No other quotes are found - no other delimiters
          if (quoteSearch === -1) {
            if (!ignoreLastRow) {
              // No closing quote... what a pity
              errors.push({
                type: "Quotes",
                code: "MissingQuotes",
                message: "Quoted field unterminated",
                row: data.length, // row has yet to be inserted
                index: this.cursor
              });
            }
            return this.finish();
          }

          // Closing quote at EOF
          if (quoteSearch === inputLen - 1) {
            const value = input
              .substring(this.cursor, quoteSearch)
              .replace(quoteCharRegex, quoteChar);
            return this.finish(value);
          }

          // If this quote is escaped, it's part of the data; skip it
          // If the quote character is the escape character, then check if the next character is the escape character
          if (
            quoteChar === escapeChar &&
            input[quoteSearch + 1] === escapeChar
          ) {
            quoteSearch++;
            continue;
          }

          // If the quote character is not the escape character, then check if the previous character was the escape character
          if (
            quoteChar !== escapeChar &&
            quoteSearch !== 0 &&
            input[quoteSearch - 1] === escapeChar
          ) {
            continue;
          }

          // Check up to nextDelim or nextNewline, whichever is closest
          const checkUpTo =
            nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
          const spacesBetweenQuoteAndDelimiter = this.extraSpaces(checkUpTo);

          // Closing quote followed by delimiter or 'unnecessary spaces + delimiter'
          if (
            input[quoteSearch + 1 + spacesBetweenQuoteAndDelimiter] ===
            delimiter
          ) {
            row.push(
              input
                .substring(this.cursor, quoteSearch)
                .replace(quoteCharRegex, quoteChar)
            );
            this.cursor =
              quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen;

            // If char after following delimiter is not quoteChar, we find next quote char position
            if (
              input[
                quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen
              ] !== quoteChar
            ) {
              quoteSearch = input.indexOf(quoteChar, this.cursor);
            }
            nextDelim = input.indexOf(delimiter, this.cursor);
            nextNewline = input.indexOf(newline, this.cursor);
            break;
          }

          const spacesBetweenQuoteAndNewLine = this.extraSpaces(nextNewline);

          // Closing quote followed by newline or 'unnecessary spaces + newLine'
          if (
            input.substr(
              quoteSearch + 1 + spacesBetweenQuoteAndNewLine,
              newlineLen
            ) === newline
          ) {
            row.push(
              input
                .substring(this.cursor, quoteSearch)
                .replace(quoteCharRegex, quoteChar)
            );
            this.saveRow(
              quoteSearch + 1 + spacesBetweenQuoteAndNewLine + newlineLen
            );
            nextDelim = input.indexOf(delimiter, this.cursor); // because we may have skipped the nextDelim in the quoted field
            quoteSearch = input.indexOf(quoteChar, this.cursor); // we search for first quote in next line

            if (preview && data.length >= preview) return this.returnable(true);

            break;
          }

          // Checks for valid closing quotes are complete (escaped quotes or quote followed by EOF/delimiter/newline) -- assume these quotes are part of an invalid text string
          errors.push({
            type: "Quotes",
            code: "InvalidQuotes",
            message: "Trailing quote on quoted field is malformed",
            row: data.length, // row has yet to be inserted
            index: this.cursor
          });

          quoteSearch++;
        }

        continue;
      }

      // Comment found at start of new line
      if (
        comments &&
        row.length === 0 &&
        input.substr(this.cursor, commentsLen) === comments
      ) {
        if (nextNewline === -1)
          // Comment ends at EOF
          return this.returnable();
        this.cursor = nextNewline + newlineLen;
        nextNewline = input.indexOf(newline, this.cursor);
        nextDelim = input.indexOf(delimiter, this.cursor);
        continue;
      }

      // Next delimiter comes before next newline, so we've reached end of field
      if (nextDelim !== -1 && (nextDelim < nextNewline || nextNewline === -1)) {
        // we check, if we have quotes, because delimiter char may be part of field enclosed in quotes
        if (quoteSearch !== -1) {
          // we have quotes, so we try to find the next delimiter not enclosed in quotes and also next starting quote char
          const nextDelimObj = this.getNextUnquotedDelimiter(
            nextDelim,
            quoteSearch,
            nextNewline
          );

          // if we have next delimiter char which is not enclosed in quotes
          if (nextDelimObj && nextDelimObj.nextDelim) {
            nextDelim = nextDelimObj.nextDelim;
            quoteSearch = nextDelimObj.quoteSearch;
            row.push(input.substring(this.cursor, nextDelim));
            this.cursor = nextDelim + delimLen;
            // we look for next delimiter char
            nextDelim = input.indexOf(delimiter, this.cursor);
            continue;
          }
        } else {
          row.push(input.substring(this.cursor, nextDelim));
          this.cursor = nextDelim + delimLen;
          nextDelim = input.indexOf(delimiter, this.cursor);
          continue;
        }
      }

      // End of row
      if (nextNewline !== -1) {
        row.push(input.substring(this.cursor, nextNewline));
        this.saveRow(nextNewline + newlineLen);

        if (stepIsFunction) {
          this.doStep();
          if (this.aborted) return this.returnable();
        }

        if (preview && data.length >= preview)
          return this.returnable(true);

        continue;
      }

      break;
    }
    return this.finish();
  }

  private parseFast(input, ignoreLastRow) {
    const stepIsFunction = isFunction(this.config.step);
    const { delimiter, comments, preview, newline } = this.config;
    const commentsLen: number =
      typeof comments === "string" ? comments.length : 0;
    const rows = input.split(newline);
    let data = [];
    for (let i = 0; i < rows.length; i++) {
      let row = rows[i];
      this.cursor += row.length;
      if (i !== rows.length - 1) this.cursor += newline.length;
      else if (ignoreLastRow) return this.returnable();
      if (comments && row.substr(0, commentsLen) === comments) continue;
      if (stepIsFunction) {
        data = [];
        this.pushRow(row.split(delimiter));
        this.doStep();
        if (this.aborted) return this.returnable();
      } else this.pushRow(row.split(delimiter));
      if (preview && i >= preview) {
        data = data.slice(0, preview);
        return this.returnable(true);
      }
    }
    return this.returnable();
  }

  /** Sets the abort flag */
  abort() {
    this.aborted = true;
  }

  /** Gets the cursor position */
  getCharIndex() {
    return this.cursor;
  }

  /**
   * checks if there are extra spaces after closing quote and given index without any text
   * if Yes, returns the number of spaces
   */
  extraSpaces(index) {
    let spaceLength = 0;
    if (index !== -1) {
      const textBetweenClosingQuoteAndIndex = input.substring(
        quoteSearch + 1,
        index
      );
      if (
        textBetweenClosingQuoteAndIndex &&
        textBetweenClosingQuoteAndIndex.trim() === ""
      ) {
        spaceLength = textBetweenClosingQuoteAndIndex.length;
      }
    }
    return spaceLength;
  }

  /**
   * Appends the remaining input from cursor to the end into
   * row, saves the row, calls step, and returns the results.
   */
  finish(value?) {
    if (ignoreLastRow) return this.returnable();
    if (typeof value === "undefined") value = input.substr(this.cursor);
    row.push(value);
    this.cursor = inputLen; // important in case parsing is paused
    this.pushRow(row);
    if (stepIsFunction) this.doStep();
    return this.returnable();
  }

  /**
   * Appends the current row to the results. It sets the cursor
   * to newCursor and finds the nextNewline. The caller should
   * take care to execute user's step function and check for
   * preview and end parsing if necessary.
   */
  saveRow(newCursor) {
    this.cursor = newCursor;
    pushRow(row);
    row = [];
    nextNewline = input.indexOf(newline, this.cursor);
  }

  /** Returns an object with the results, errors, and meta. */
  returnable(stopped?, step?) {
    const isStep = step || false;
    return {
      data: isStep ? data[0] : data,
      errors,
      meta: {
        delimiter: this.delim,
        linebreak: this.newline,
        aborted: this.aborted,
        truncated: !!stopped,
        cursor: lastCursor + (baseIndex || 0)
      }
    };
  }

  pushRow(row) {
    data.push(row);
    lastCursor = this.cursor;
  }

  /** Executes the user's step function and resets data & errors. */
  doStep() {
    step(returnable(undefined, true));
    data = [];
    errors = [];
  }

  /** Gets the delimiter character, which is not inside the quoted field */
  getNextUnquotedDelimiter(nextDelim, quoteSearch, newLine) {
    let result = {
      nextDelim: undefined,
      quoteSearch: undefined
    };
    // get the next closing quote character
    let nextQuoteSearch = input.indexOf(this.quoteChar, quoteSearch + 1);

    // if next delimiter is part of a field enclosed in quotes
    if (
      nextDelim > quoteSearch &&
      nextDelim < nextQuoteSearch &&
      (nextQuoteSearch < newLine || newLine === -1)
    ) {
      // get the next delimiter character after this one
      const nextNextDelim = input.indexOf(this.delim, nextQuoteSearch);

      // if there is no next delimiter, return default result
      if (nextNextDelim === -1) {
        return result;
      }
      // find the next opening quote char position
      if (nextNextDelim > nextQuoteSearch) {
        nextQuoteSearch = input.indexOf(this.quoteChar, nextQuoteSearch + 1);
      }
      // try to get the next delimiter position
      result = this.getNextUnquotedDelimiter(
        nextNextDelim,
        nextQuoteSearch,
        newLine
      );
    } else {
      result = {
        nextDelim,
        quoteSearch
      };
    }

    return result;
  }
}

interface ParserConfig {
  quoteChar?: string;
  escapeChar?: string;
  delimiter?: string;
  newline?: string;
  comments?: string | boolean;
  preview?: number;
  fastMode?: boolean;
  step?: Function;
}
