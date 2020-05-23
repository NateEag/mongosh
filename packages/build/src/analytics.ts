import { promises as fs } from 'fs';
import handlebars from 'handlebars';

/**
 * The template.
 */
const TEMPLATE = `module.exports = { SEGMENT_API_KEY: "{{segmentKey}}" };`;

/**
 * Create the analytics config.
 *
 * @param {string} segmentKey - The segment key.
 *
 * @returns {string} The compiled template.
 */
const createAnalyticsConfig = (segmentKey: string): string => {
  const template = handlebars.compile(TEMPLATE);
  return template({ segmentKey: segmentKey });
};

/**
 * Write the analytics config.
 *
 * @param {string} file - The filename.
 * @param {string} segmentKey - The segment key.
 */
const writeAnalyticsConfig = (file: string, segmentKey: string) => {
  const template = createAnalyticsConfig(segmentKey);
  console.log('mongosh: writing analytics template:', file);
  return fs.writeFile(file, template);
};

export default writeAnalyticsConfig;
export { createAnalyticsConfig };
