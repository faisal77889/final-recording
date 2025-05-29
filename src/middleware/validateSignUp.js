const validator = require("validator");

const validateSignUp = (data, isSignUp) => {
  let { name, emailId, password } = data;

  if (isSignUp) {
    if (!name) {
      throw new Error("Name is a required field");
    }
    name = name.trim();
    if (name.length < 3) {
      throw new Error("Name must be greater than two letters");
    }
  }

  if (!emailId || !validator.isEmail(emailId.trim().toLowerCase())) {
    throw new Error("The email Id is wrong");
  }
  emailId = emailId.trim().toLowerCase();

  if (!password || !validator.isStrongPassword(password)) {
    throw new Error("Enter a strong password");
  }

  if (isSignUp) {
    return { name, emailId, password };
  }
  return { emailId, password };
};

module.exports = validateSignUp;
