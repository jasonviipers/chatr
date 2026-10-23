import * as fabric from 'fabric';
import { findIndex, forEach } from 'lodash';
import {
  MeetingWhiteboardDrawingsState,
  MeetingWhiteboardDrawingState,
} from '../../pages/Meeting/Meeting.state';
import WhiteboardCanvasService from './WhiteboardCanvasService';

export type DrawingAddEvent = { target: fabric.FabricObject };

type DrawingParseCallback = (drawings: MeetingWhiteboardDrawingsState) => void;
type DrawingHandleAddCallback = (event: DrawingAddEvent) => void;

export default class WhiteboardDrawingService {
  protected whiteboardCanvasService: WhiteboardCanvasService;

  constructor() {
    this.whiteboardCanvasService = new WhiteboardCanvasService();
  }

  get canvas() {
    return this.whiteboardCanvasService.getCanvas();
  }

  parse(
    drawing: MeetingWhiteboardDrawingState,
    callback: DrawingParseCallback,
  ) {
    // enlivenObjects is promise based since fabric 6
    fabric.util
      .enlivenObjects<fabric.FabricObject>([drawing])
      .then((drawings) => callback(drawings));
  }

  isExists(drawing: MeetingWhiteboardDrawingState) {
    const drawings = JSON.parse(JSON.stringify(this.getDrawings()));
    // lodash deep-matches the plain (serialized) drawing against the existing ones
    const isExists =
      findIndex(drawings, drawing as unknown as Record<string, unknown>) >= 0;
    return isExists;
  }

  add(drawings: MeetingWhiteboardDrawingsState) {
    forEach(drawings, (drawing) => this.canvas.add(drawing));
  }

  getDrawings(): MeetingWhiteboardDrawingsState {
    return this.canvas.getObjects();
  }

  handleAdd(callback: DrawingHandleAddCallback) {
    this.canvas.on('object:added', callback);
  }
}
