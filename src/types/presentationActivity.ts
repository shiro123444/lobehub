/** A replacement status line, never a transcript or model reasoning. */
export interface PresentationActivity {
  operation: string;
  state: 'started' | 'completed' | 'failed';
  text: string;
}
