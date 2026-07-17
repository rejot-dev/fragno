class ArithmeticExpressionParser {
  private position = 0;

  constructor(private readonly expression: string) {}

  parse(): number {
    const result = this.parseSum();
    this.skipWhitespace();

    if (this.position !== this.expression.length) {
      this.throwUnexpectedToken();
    }

    return result;
  }

  private parseSum(): number {
    let result = this.parseProduct();

    while (true) {
      if (this.consume("+")) {
        result += this.parseProduct();
      } else if (this.consume("-")) {
        result -= this.parseProduct();
      } else {
        return result;
      }
    }
  }

  private parseProduct(): number {
    let result = this.parseUnary();

    while (true) {
      if (this.consume("*")) {
        result *= this.parseUnary();
      } else if (this.consume("/")) {
        result /= this.parseUnary();
      } else if (this.consume("%")) {
        result %= this.parseUnary();
      } else {
        return result;
      }
    }
  }

  private parseUnary(): number {
    if (this.consume("+")) {
      return this.parseUnary();
    }
    if (this.consume("-")) {
      return -this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.consume("(")) {
      const result = this.parseSum();
      if (!this.consume(")")) {
        this.throwUnexpectedToken();
      }
      return result;
    }

    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const remaining = this.expression.slice(this.position);
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(remaining);

    if (!match) {
      this.throwUnexpectedToken();
    }

    this.position += match[0].length;
    return Number(match[0]);
  }

  private consume(token: string): boolean {
    this.skipWhitespace();
    if (!this.expression.startsWith(token, this.position)) {
      return false;
    }

    this.position += token.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.expression[this.position] ?? "")) {
      this.position += 1;
    }
  }

  private throwUnexpectedToken(): never {
    throw new Error(`Invalid DSL calc expression at position ${this.position}.`);
  }
}

export const evaluateArithmeticExpression = (expression: string): number =>
  new ArithmeticExpressionParser(expression).parse();
