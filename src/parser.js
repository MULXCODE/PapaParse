// @flow
import { isFunction, escapeRegExp } from "./utils";

// @TODO: Link this to global Papa.config
const BAD_DELIMITERS /*: string[] */ = [];

export default class Parser {
  cursor /*: number */ = 0;
  quoteChar /*: string */;
  escapeChar /*: string */;
  delim /*: string */;
  newline /*: string */;
  comments /*: string|boolean */;
  preview /*: number */;
  fastMode /*: boolean */;
  aborted /*: boolean */;

  constructor(config) {
    // Unpack the config object
    config = config || {};
    this.delim = config.delimiter;
    this.newline = config.newline;
    this.comments = config.comments;
    this.step = config.step;
    this.preview = config.preview;
    this.fastMode = config.fastMode;

    /** Allows for no quoteChar by setting quoteChar to undefined in config */
    if (config.quoteChar === undefined) {
      this.quoteChar = '"';
    } else {
      this.quoteChar = config.quoteChar;
    }
    this.escapeChar =
      config.escapeChar !== undefined ? config.escapeChar : this.quoteChar;

    // Delimiter must be valid
    if (
      typeof this.delim !== "string" ||
      BAD_DELIMITERS.indexOf(this.delim) > -1
    )
      this.delim = ",";

    // Comment character must be valid
    if (this.comments === this.delim)
      throw new Error("Comment character same as delimiter");
    else if (this.comments === true) this.comments = "#";
    else if (
      typeof this.comments !== "string" ||
      BAD_DELIMITERS.indexOf(this.comments) > -1
    )
      this.comments = false;

    // Newline must be valid: \r, \n, or \r\n
    if (
      this.newline !== "\n" &&
      this.newline !== "\r" &&
      this.newline !== "\r\n"
    )
      this.newline = "\n";

    // We're gonna need these at the Parser scope
    this.aborted = false;
  }

  parse(
    input /*: string*/,
    baseIndex /*: number*/,
    ignoreLastRow /*: boolean*/
  ) {
    // For some reason, in Chrome, this speeds things up (!?)
    if (typeof input !== "string") throw new Error("Input must be a string");

    // We don't need to compute some of these every time parse() is called,
    // but having them in a more local scope seems to perform better
    const inputLen = input.length,
      delimLen = this.delim.length,
      newlineLen = this.newline.length,
      commentsLen = this.comments.length;
    const stepIsFunction = isFunction(this.step);

    // Establish starting state
    this.cursor = 0;
    let data = [],
      errors = [],
      row = [],
      lastCursor = 0;

    if (!input) return this.returnable();

    if (
      this.fastMode ||
      (this.fastMode !== false && input.indexOf(this.quoteChar) === -1)
    ) {
      const rows = input.split(this.newline);
      for (let i = 0; i < rows.length; i++) {
        row = rows[i];
        this.cursor += row.length;
        if (i !== rows.length - 1) this.cursor += this.newline.length;
        else if (ignoreLastRow) return this.returnable();
        if (this.comments && row.substr(0, commentsLen) === this.comments)
          continue;
        if (stepIsFunction) {
          data = [];
          this.pushRow(row.split(this.delim));
          this.doStep();
          if (this.aborted) return this.returnable();
        } else this.pushRow(row.split(this.delim));
        if (this.preview && i >= this.preview) {
          data = data.slice(0, this.preview);
          return this.returnable(true);
        }
      }
      return this.returnable();
    }

    let nextDelim = input.indexOf(this.delim, this.cursor);
    let nextNewline = input.indexOf(this.newline, this.cursor);
    const quoteCharRegex = new RegExp(
      escapeRegExp(this.escapeChar) + escapeRegExp(this.quoteChar),
      "g"
    );
    let quoteSearch = input.indexOf(this.quoteChar, this.cursor);

    // Parser loop
    for (;;) {
      // Field has opening quote
      if (input[this.cursor] === this.quoteChar) {
        // Start our search for the closing quote where the cursor is
        quoteSearch = this.cursor;

        // Skip the opening quote
        this.cursor++;

        for (;;) {
          // Find closing quote
          quoteSearch = input.indexOf(this.quoteChar, quoteSearch + 1);

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
            return finish();
          }

          // Closing quote at EOF
          if (quoteSearch === inputLen - 1) {
            const value = input
              .substring(this.cursor, quoteSearch)
              .replace(quoteCharRegex, this.quoteChar);
            return finish(value);
          }

          // If this quote is escaped, it's part of the data; skip it
          // If the quote character is the escape character, then check if the next character is the escape character
          if (
            this.quoteChar === this.escapeChar &&
            input[quoteSearch + 1] === this.escapeChar
          ) {
            quoteSearch++;
            continue;
          }

          // If the quote character is not the escape character, then check if the previous character was the escape character
          if (
            this.quoteChar !== this.escapeChar &&
            quoteSearch !== 0 &&
            input[quoteSearch - 1] === this.escapeChar
          ) {
            continue;
          }

          // Check up to nextDelim or nextNewline, whichever is closest
          const checkUpTo =
            nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
          const spacesBetweenQuoteAndDelimiter = extraSpaces(checkUpTo);

          // Closing quote followed by delimiter or 'unnecessary spaces + delimiter'
          if (
            input[quoteSearch + 1 + spacesBetweenQuoteAndDelimiter] ===
            this.delim
          ) {
            row.push(
              input
                .substring(this.cursor, quoteSearch)
                .replace(quoteCharRegex, this.quoteChar)
            );
            this.cursor =
              quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen;

            // If char after following delimiter is not quoteChar, we find next quote char position
            if (
              input[
                quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen
              ] !== this.quoteChar
            ) {
              quoteSearch = input.indexOf(this.quoteChar, this.cursor);
            }
            nextDelim = input.indexOf(this.delim, this.cursor);
            nextNewline = input.indexOf(this.newline, this.cursor);
            break;
          }

          const spacesBetweenQuoteAndNewLine = extraSpaces(nextNewline);

          // Closing quote followed by newline or 'unnecessary spaces + newLine'
          if (
            input.substr(
              quoteSearch + 1 + spacesBetweenQuoteAndNewLine,
              newlineLen
            ) === this.newline
          ) {
            row.push(
              input
                .substring(this.cursor, quoteSearch)
                .replace(quoteCharRegex, this.quoteChar)
            );
            saveRow(
              quoteSearch + 1 + spacesBetweenQuoteAndNewLine + newlineLen
            );
            nextDelim = input.indexOf(this.delim, this.cursor); // because we may have skipped the nextDelim in the quoted field
            quoteSearch = input.indexOf(this.quoteChar, this.cursor); // we search for first quote in next line

            if (this.preview && data.length >= this.preview)
              return returnable(true);

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
        this.comments &&
        row.length === 0 &&
        input.substr(this.cursor, commentsLen) === this.comments
      ) {
        if (nextNewline === -1)
          // Comment ends at EOF
          return this.returnable();
        this.cursor = nextNewline + newlineLen;
        nextNewline = input.indexOf(this.newline, this.cursor);
        nextDelim = input.indexOf(this.delim, this.cursor);
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
            nextDelim = input.indexOf(this.delim, this.cursor);
            continue;
          }
        } else {
          row.push(input.substring(this.cursor, nextDelim));
          this.cursor = nextDelim + delimLen;
          nextDelim = input.indexOf(this.delim, this.cursor);
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

        if (this.preview && data.length >= this.preview)
          return this.returnable(true);

        continue;
      }

      break;
    }
    return this.finish();
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
  finish(value) {
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
  returnable(stopped, step) {
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
      result = this.getNextUnquotedDelimiter(nextNextDelim, nextQuoteSearch, newLine);
    } else {
      result = {
        nextDelim,
        quoteSearch
      };
    }

    return result;
  }
}
