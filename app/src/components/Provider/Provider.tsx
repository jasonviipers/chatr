import { IonReactRouter } from '@ionic/react-router'
import React, { Component, ReactNode } from 'react'
import { Provider as ReduxProvider } from 'react-redux'
import { Routes } from 'react-router-dom'
import store from '../../store'

interface ProviderProps {
  children?: ReactNode
}

// Routes are mounted/unmounted on navigation (no page stack, no transitions),
// which is how the app behaved before. Ionic's <IonRouterOutlet> keeps every
// visited page mounted and animates between them, so it is not used here.
export default class Provider extends Component<ProviderProps> {
  render () {
    return (
      <ReduxProvider store={store}>
        <IonReactRouter>
          <Routes>
            {this.props.children}
          </Routes>
        </IonReactRouter>
      </ReduxProvider>
    )
  }
}
