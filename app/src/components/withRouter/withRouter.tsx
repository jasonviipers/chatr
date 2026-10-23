import React, { ComponentType, useMemo } from 'react';
import { Location, Params, useLocation, useNavigate, useParams } from 'react-router-dom';

// @ionic/react-router v9 requires react-router v6, which dropped `withRouter`
// and the `history` object. This keeps the v5-style `props.history` the class
// components were written against, backed by the v6 hooks.

export interface History {
  location: Location;
  push: (path: string, state?: unknown) => void;
  replace: (path: string, state?: unknown) => void;
  goBack: () => void;
}

export interface RouteComponentProps {
  history: History;
  location: Location;
  match: { params: Params };
}

export function withRouter<P extends RouteComponentProps>(
  WrappedComponent: ComponentType<P>,
) {
  function WithRouter(props: Omit<P, keyof RouteComponentProps>) {
    const navigate = useNavigate();
    const location = useLocation();
    const params = useParams();
    const history = useMemo<History>(
      () => ({
        location,
        push: (path, state) => navigate(path, { state }),
        replace: (path, state) => navigate(path, { replace: true, state }),
        goBack: () => navigate(-1),
      }),
      [navigate, location],
    );
    return (
      <WrappedComponent
        {...(props as P)}
        history={history}
        location={location}
        match={{ params }}
      />
    );
  }
  WithRouter.displayName = `withRouter(${
    WrappedComponent.displayName || WrappedComponent.name || 'Component'
  })`;
  return WithRouter;
}
