/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @emails oncall+javascript_tools
 * @format
 */

'use strict';

jest.mock('../../Bundler');

const Bundler = require('../../Bundler');
const {EventEmitter} = require('events');

const DeltaCalculator = require('../DeltaCalculator');

describe('DeltaCalculator', () => {
  const moduleFoo = createModule({path: '/foo', name: 'foo'});
  const moduleBar = createModule({path: '/bar', name: 'bar'});
  const moduleBaz = createModule({path: '/baz', name: 'baz'});

  let deltaCalculator;
  let fileWatcher;
  let mockedDependencies;
  let mockedDependencyTree;

  const bundlerMock = new Bundler();

  const options = {
    assetPlugins: [],
    dev: true,
    entryFile: 'bundle.js',
    entryModuleOnly: false,
    excludeSource: false,
    generateSourceMaps: false,
    hot: true,
    inlineSourceMap: true,
    isolateModuleIDs: false,
    minify: false,
    platform: 'ios',
    runBeforeMainModule: ['core'],
    runModule: true,
    sourceMapUrl: undefined,
    unbundle: false,
  };

  function createModule({path, name, isAsset, isJSON}) {
    return {
      path,
      async getName() {
        return name;
      },
      isAsset() {
        return !!isAsset;
      },
      isJSON() {
        return !!isAsset;
      },
    };
  }

  beforeEach(async () => {
    mockedDependencies = [moduleFoo, moduleBar, moduleBaz];
    mockedDependencyTree = new Map([[moduleFoo, [moduleBar, moduleBaz]]]);

    fileWatcher = new EventEmitter();

    Bundler.prototype.getResolver.mockReturnValue(
      Promise.resolve({
        getDependencyGraph() {
          return {
            getWatcher() {
              return fileWatcher;
            },
          };
        },
      }),
    );

    Bundler.prototype.getDependencies.mockImplementation(async () => {
      return {
        options: {},
        dependencies: mockedDependencies,
        getResolvedDependencyPairs(module) {
          const deps = mockedDependencyTree.get(module);
          return deps ? deps.map(dep => [dep.name, dep]) : [];
        },
      };
    });

    Bundler.prototype.getModuleForPath.mockImplementation(async path => {
      return mockedDependencies.filter(dep => dep.path === path)[0];
    });

    Bundler.prototype.getShallowDependencies.mockImplementation(
      async module => {
        const deps = mockedDependencyTree.get(module);
        return deps ? await Promise.all(deps.map(dep => dep.getName())) : [];
      },
    );

    deltaCalculator = await DeltaCalculator.create(bundlerMock, options);
  });

  it('should start listening for file changes after being initialized', async () => {
    expect(fileWatcher.listeners('change')).toHaveLength(1);
  });

  it('should stop listening for file changes after being destroyed', () => {
    deltaCalculator.end();

    expect(fileWatcher.listeners('change')).toHaveLength(0);
  });

  it('should calculate the initial bundle correctly', async () => {
    const result = await deltaCalculator.getDelta();

    expect(result).toEqual({
      modified: new Map([
        ['/foo', moduleFoo],
        ['/bar', moduleBar],
        ['/baz', moduleBaz],
      ]),
      deleted: new Set(),
      reset: true,
    });
  });

  it('should return an empty delta when there are no changes', async () => {
    await deltaCalculator.getDelta();

    expect(await deltaCalculator.getDelta()).toEqual({
      modified: new Map(),
      deleted: new Set(),
    });
  });

  it('should calculate a delta after a simple modification', async () => {
    // Get initial delta
    await deltaCalculator.getDelta();

    fileWatcher.emit('change', {eventsQueue: [{filePath: '/foo'}]});

    const result = await deltaCalculator.getDelta();
    expect(result).toEqual({
      modified: new Map([['/foo', moduleFoo]]),
      deleted: new Set(),
    });
  });

  it('should calculate a delta after removing a dependency', async () => {
    // Get initial delta
    await deltaCalculator.getDelta();

    fileWatcher.emit('change', {eventsQueue: [{filePath: '/foo'}]});

    // Remove moduleBar
    mockedDependencyTree.set(moduleFoo, [moduleBaz]);
    mockedDependencies = [moduleFoo, moduleBaz];

    const result = await deltaCalculator.getDelta();
    expect(result).toEqual({
      modified: new Map([['/foo', moduleFoo]]),
      deleted: new Set(['/bar']),
    });
  });

  it('should calculate a delta after adding/removing dependencies', async () => {
    // Get initial delta
    await deltaCalculator.getDelta();

    fileWatcher.emit('change', {eventsQueue: [{filePath: '/foo'}]});

    // Add moduleQux
    const moduleQux = createModule({path: '/qux', name: 'qux'});
    mockedDependencyTree.set(moduleFoo, [moduleQux]);
    mockedDependencies = [moduleFoo, moduleQux];

    const result = await deltaCalculator.getDelta();
    expect(result).toEqual({
      modified: new Map([['/foo', moduleFoo], ['/qux', moduleQux]]),
      deleted: new Set(['/bar', '/baz']),
    });
  });

  it('should emit an event when there is a relevant file change', async done => {
    await deltaCalculator.getDelta();

    deltaCalculator.on('change', () => done());

    fileWatcher.emit('change', {eventsQueue: [{filePath: '/foo'}]});
  });

  it('should not emit an event when there is a file changed outside the bundle', async () => {
    jest.useFakeTimers();

    const onChangeFile = jest.fn();
    await deltaCalculator.getDelta();

    deltaCalculator.on('change', onChangeFile);
    fileWatcher.emit('change', {eventsQueue: [{filePath: '/another'}]});

    jest.runAllTimers();

    expect(onChangeFile.mock.calls.length).toBe(0);
  });
});
