import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent 会自动处理：
//  - 在 Expo Go / 开发构建中注册根组件
//  - 在原生工程中调用 AppRegistry.registerComponent('main', () => App)
registerRootComponent(App);
