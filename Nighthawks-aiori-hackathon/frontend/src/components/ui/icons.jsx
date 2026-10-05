import { createElement } from 'react';
import { iconFor } from './tokens.js';

/**
 * Renders a registered icon by key.
 *
 * Going through one component rather than resolving lucide components inside
 * render bodies keeps the icon lookup in a single place, and means no component
 * ever defines an element type during its own render.
 */
export default function Icon({ name, size = 16, className = '', ...rest }) {
  return createElement(iconFor(name), { size, className, ...rest });
}
