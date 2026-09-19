/**
 * The one word every permanent delete asks for. Defined in contracts so the
 * import screen's «fresh start» and its server route read the same string;
 * re-exported here so the hub modals keep one import path.
 */
export { DELETE_WORD, isDeleteWord as typedDeleteWord } from '@shikoo/contracts';
