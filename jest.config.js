import { jest } from '@darkobits/ts';

export default jest({
  coverageThreshold: {
    global: {
      branches: 90,
      lines: 95,
      statements: 95
    }
  }
});
