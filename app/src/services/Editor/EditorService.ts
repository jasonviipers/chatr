import Quill from 'quill';

export default class EditorService {
  private static instance: EditorService;
  private static editor: Quill;

  constructor() {
    if (!EditorService.instance) {
      EditorService.instance = this;
    }
    return EditorService.instance;
  }

  private getDelta(content: any) {
    // Quill 2 takes { html } here; Quill 1 took the html string directly
    return EditorService.editor.clipboard.convert({ html: content });
  }

  private getContent() {
    // Not root.innerHTML: Quill 2 writes bullet lists as <ol><li data-list="bullet">, which the server's HTML
    // clean-up (it drops data-* attributes) would turn into a numbered list. The semantic HTML has real <ul>/<ol>,
    // but it writes every space as &nbsp;, which makes a paragraph one unbreakable word: turn them back into spaces.
    return EditorService.editor.getSemanticHTML().replace(/&nbsp;/g, ' ');
  }

  get toolbarOptions() {
    return [
      ['bold', 'italic', 'underline'],
      [{ header: 1 }, { header: 2 }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      [{ align: [] }],
      ['link'],
    ];
  }

  get options() {
    return {
      modules: {
        toolbar: this.toolbarOptions,
        clipboard: {
          matchVisual: false,
        },
      },
      theme: 'snow',
    };
  }

  initialize(container: string) {
    EditorService.editor = new Quill(container, this.options);
  }

  setContent(content: string) {
    const delta = this.getDelta(content);
    EditorService.editor.setContents(delta, 'silent');
  }

  onContentChange(callback: (content: string) => void) {
    EditorService.editor.on('text-change', () => {
      const content = this.getContent();
      callback(content);
    });
  }
}
