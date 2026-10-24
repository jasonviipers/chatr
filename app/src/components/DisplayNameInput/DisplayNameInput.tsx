import React, { ChangeEvent, Component } from 'react';
import Input from '../Input/Input';
import DisplayNameService, { DISPLAY_NAME_MAX_LENGTH } from '../../services/DisplayNameService';

interface DisplayNameInputState {
  value: string;
}

/**
 * "Your name (optional)": what the others in a meeting see instead of "Participant". Remembered on this device.
 * It has its own state (not the page's), so the Join and Start pages stay as they are.
 */
export default class DisplayNameInput extends Component<object, DisplayNameInputState> {
  private mounted = false;

  constructor(props: object) {
    super(props);
    this.state = { value: DisplayNameService.current() };
    this.handleChange = this.handleChange.bind(this);
  }

  componentDidMount() {
    this.mounted = true;
    void DisplayNameService.load().then((name) => {
      // do not overwrite what is being typed while the saved name was being read
      if (this.mounted && this.state.value === '') this.setState({ value: name });
    });
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  handleChange(event: ChangeEvent) {
    const { value } = event.target as HTMLInputElement;
    this.setState({ value });
    DisplayNameService.set(value);
  }

  render() {
    return (
      <Input
        name="displayName"
        type="text"
        value={this.state.value}
        placeholder="Your name (optional)"
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        handleChange={this.handleChange}
      />
    );
  }
}
