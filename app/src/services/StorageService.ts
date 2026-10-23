import { isPlatform } from '@ionic/react';
import { Preferences } from '@capacitor/preferences';

export default class StorageService {
  protected storage = Preferences;

  protected isElectron: boolean = isPlatform('electron');

  async get(key: string) {
    if (this.isElectron) {
      return window.localStorage.getItem(key);
    } else {
      const { value } = await this.storage.get({ key });
      return value;
    }
  }

  async set(key: string, value: any) {
    if (this.isElectron) {
      window.localStorage.setItem(key, value);
    } else {
      await this.storage.set({ key, value });
    }
  }

  async remove(key: string) {
    if (this.isElectron) {
      window.localStorage.removeItem(key);
    } else {
      await this.storage.remove({ key });
    }
  }
}
