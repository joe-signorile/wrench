// Errors wrench raises deliberately, with a message meant for the user.
// bin/wrench.mjs prints these bare; anything else gets a full stack, because
// anything else is a bug in wrench.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
