require("util").inspect.defaultOptions.depth = 5;

module.exports = {
  timeout: "300000",
  files: ["**/*.ava.js"],
  failWithoutAssertions: false,
  extensions: ["js"],
};
