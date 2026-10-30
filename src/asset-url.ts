/**
 * A file from the public folder (fonts), resolved against wherever the site is served, so it also works
 * when hosted in a sub-folder such as GitHub Pages' /qp-setter/.
 */
export const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;
