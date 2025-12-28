/**
 * WordMatcher responsible for finding and highlighting words in the DOM.
 * Uses CSS Custom Highlight API for performant rendering.
 */

// Define CSS.highlights if not available in types (it is in newer TS/lib.dom.d.ts but often missing)
// @ts-ignore
declare const CSS: any;
// @ts-ignore
declare class Highlight {
    constructor(...ranges: Range[]);
}

export class WordMatcher {
  private walker: TreeWalker;
  private currentNode: Node | null;
  private currentOffset: number;
  private highlightName = 'tts-active';

  constructor(startNode: Node, startOffset: number) {
    this.currentNode = startNode;
    this.currentOffset = startOffset;
    
    // Initialize walker at specific point?
    // TreeWalker doesn't support "start at arbitrary node/offset" easily.
    // It starts at root.
    // So we use a walker rooted at the common ancestor or just body, 
    // but manually skip until we hit startNode.
    
    // Optimization: Walk from startNode parent or body
    const root = startNode.parentElement || document.body;
    this.walker = document.createTreeWalker(
      document.body, // Always walk body to find next nodes even if outside parent
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
            // Visibility checks identical to textExtraction
            const element = node.parentElement;
            if (!element) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
            if (['script', 'style', 'noscript'].includes(element.tagName.toLowerCase())) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Fast-forward walker to startNode
    this.walker.currentNode = startNode;
  }

  /**
   * Clears any active highlight.
   */
  clear() {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete(this.highlightName);
    }
  }

  /**
   * Advances the internal position past the given word WITHOUT changing the highlight.
   * Used for sentence/paragraph mode to keep track of position while not updating highlight.
   */
  advancePosition(word: string): void {
    if (!word || !word.trim()) return;
    
    const cleanWord = word.trim();
    
    const findWord = (node: Node, minOffset: number): [Node, number] | null => {
       if (node.nodeType !== Node.TEXT_NODE) return null;
       
       const textContent = node.textContent || '';
       const searchText = textContent.substring(minOffset);
       const normSearchText = searchText.replace(/\u00A0/g, ' ');
       const normWord = cleanWord.replace(/\u00A0/g, ' ');
       
       const index = normSearchText.indexOf(normWord);
       
       if (index !== -1) {
           const end = minOffset + index + normWord.length;
           return [node, end];
       }
       return null;
    };

    // Check current node
    if (this.currentNode) {
        const result = findWord(this.currentNode, this.currentOffset);
        if (result) {
            this.currentOffset = result[1];
            this.walker.currentNode = result[0];
            return;
        }
    }
    
    // Search next nodes
    let ops = 0;
    while (ops < 50) {
        const nextNode = this.walker.nextNode();
        if (!nextNode) break;
        ops++;
        
        this.currentNode = nextNode;
        this.currentOffset = 0;
        
        const result = findWord(nextNode, 0);
        if (result) {
            this.currentOffset = result[1];
            this.walker.currentNode = result[0];
            return;
        }
    }
  }

  /**
   * Highlights the next occurrence of the given word text.
   * @returns The node that was highlighted (or part of it), to aid auto-scrolling
   */
  highlightWord(word: string, mode: 'word' | 'sentence' | 'paragraph' = 'word'): Node | null {
    if (!word || !word.trim()) return null;
    
    // Normalize word
    const cleanWord = word.trim();

    // Helper to search within a node starting from a minimum offset
    // Returns [foundNode, foundStart, foundEnd] or null
    const checkNode = (node: Node, minOffset: number): [Node, number, number] | null => {
       if (node.nodeType !== Node.TEXT_NODE) return null;
       
       const textContent = node.textContent || '';
       
       // Search starting from minOffset
       const searchText = textContent.substring(minOffset);
       const normSearchText = searchText.replace(/\u00A0/g, ' ');
       const normWord = cleanWord.replace(/\u00A0/g, ' ');
       
       const index = normSearchText.indexOf(normWord);
       
       if (index !== -1) {
           const start = minOffset + index;
           const end = start + normWord.length;
           return [node, start, end];
       }
       return null;
    };

    let result: [Node, number, number] | null = null;

    // 1. Check current node starting from currentOffset
    if (this.currentNode) {
        result = checkNode(this.currentNode, this.currentOffset);
    }
    
    // 2. Search next nodes ONLY if not found in current node
    //    This prevents jumping backwards to earlier nodes
    if (!result) {
        let ops = 0;
        while (ops < 50) {
            const nextNode = this.walker.nextNode();
            if (!nextNode) break;
            ops++;
            
            // Move to next node, reset offset to 0
            this.currentNode = nextNode;
            this.currentOffset = 0;
            
            result = checkNode(nextNode, 0);
            if (result) break;
        }
    }

    if (result) {
        const [foundNode, foundStart, foundEnd] = result;
        
        // Determine range based on mode
        let rangeStart = foundStart;
        let rangeEnd = foundEnd;

        if (mode === 'paragraph' && foundNode.parentElement) {
            const parent = foundNode.parentElement;
            const range = document.createRange();
            range.selectNodeContents(parent);
            this.applyHighlight(range);
            
            // Update position tracking
            this.currentNode = foundNode;
            this.currentOffset = foundEnd;
            this.walker.currentNode = foundNode;
            return parent;
        } else if (mode === 'sentence') {
            const fullText = foundNode.textContent || '';
            
            // Expand left
            while (rangeStart > 0) {
                const char = fullText[rangeStart - 1];
                if (['.', '?', '!', '\n'].includes(char)) break;
                rangeStart--;
            }
            // Expand right
            while (rangeEnd < fullText.length) {
                const char = fullText[rangeEnd];
                if (['.', '?', '!', '\n'].includes(char)) {
                    rangeEnd++; 
                    break;
                }
                rangeEnd++;
            }
            
            this.highlightRange(foundNode, rangeStart, rangeEnd);
        } else {
            // Word mode
            this.highlightRange(foundNode, rangeStart, rangeEnd);
        }

        // CRITICAL: Keep walker in sync with our position
        this.currentNode = foundNode;
        this.currentOffset = foundEnd;
        this.walker.currentNode = foundNode;
        return foundNode;
    }
    
    return null;
  }
  
  private applyHighlight(range: Range) {
      if (typeof CSS === 'undefined' || !CSS.highlights) return;
      try {
          const highlight = new Highlight(range);
          CSS.highlights.set(this.highlightName, highlight);
      } catch (e) {
          console.warn('Highlight err', e);
      }
  }

  private highlightRange(node: Node, start: number, end: number) {
      if (typeof CSS === 'undefined' || !CSS.highlights) return;

      try {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          
          const highlight = new Highlight(range);
          CSS.highlights.set(this.highlightName, highlight);
      } catch (e) {
          console.warn('Highlight err', e);
      }
  }
}
