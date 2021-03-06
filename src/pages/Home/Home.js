import { useRef, useEffect, useState, useCallback } from "react";
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "vtk.js/Sources/Rendering/Profiles/Geometry";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkFullScreenRenderWindow from "@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkPolyDataReader from "vtk.js/Sources/IO/Legacy/PolyDataReader";
import vtkPointPicker from "vtk.js/Sources/Rendering/Core/PointPicker";
import vtkSphereSource from "vtk.js/Sources/Filters/Sources/SphereSource";
import { get } from "../../http/api";
import { deepClone } from "../../utils/index";
import { Graph } from "../../utils/graph";
/**
 * @vtk文件对应关系
 * POINT_ID 从0开始，对应POINT_DATA 的第一个点
 */
const colorMap = {
  0: [1, 1, 0], // 普通颜色
  1: [1, 0, 0], // 选中"点"的颜色
};
const generateGraph = (linesList, heightList) => {
  let pointsNumber = heightList.length;
  let edgesNumber = linesList.length;
  let arr = [];
  for (let i = 0; i < pointsNumber; i++) {
    arr[i] = [];
    for (let j = 0; j < pointsNumber; j++) {
      arr[i][j] = 0;
      linesList.forEach((edge) => {
        if (
          (edge[0] === i && edge[1] === j) ||
          (edge[1] === i && edge[0] === j)
        ) {
          arr[i][j] = 1;
        }
      });
    }
  }
  return new Graph(deepClone(heightList), arr, pointsNumber, edgesNumber);
};

function Home() {
  const vtkContainerRef = useRef(null);
  const context = useRef(null);
  const heightListRef = useRef([]); // 点的高度list
  const closeList = useRef([]); // 已折叠子树的点ID的list
  const linesRef = useRef([]); // 当前线结构list
  const linesCopyRef = useRef([]); // 备份线结构list
  const sonNodeMap = useRef({}); // 每个节点对应的子节点集合
  const graphRef = useRef(); // 图结构
  const pointsColorMap = useRef([]); // 点集颜色

  const lowRef = useRef(null); // 最小值
  const highRef = useRef(null); // 最大值
  const displayPointsRef = useRef([]); // 暂存当前显示的点集

  /**
   * 判断节点是否应该显示
   */
  const judgeValidity = useCallback(
    (id) => displayPointsRef.current.includes(id),
    [displayPointsRef.current]
  );
  /**
   * click节点 展开/收起子树
   */
  const collapseLines = useCallback(
    (id) => {
      const {
        polydata,
        actor,
        mapper,
        renderer,
        renderWindow,
        picker,
        pointsActors,
      } = context.current;

      if (closeList.current.indexOf(id) >= 0) {
        /**
         * 展开子树
         */
        closeList.current = closeList.current.filter((i) => i !== id);
        const tree = graphRef.current.bfs(id);
        tree.forEach((i) => {
          if (judgeValidity(i[0]) && judgeValidity(i[1])) {
            linesRef.current.push(2, i[0], i[1]);
          }
        });
        sonNodeMap.current[id].forEach((i) => {
          if (judgeValidity(i)) {
            const sphere = vtkSphereSource.newInstance();
            sphere.setCenter(...polydata.getPoints().getPoint(i));
            sphere.setRadius(0.15);
            const sphereMapper = vtkMapper.newInstance();
            sphereMapper.setInputData(sphere.getOutputData());
            pointsActors[i] = vtkActor.newInstance();
            pointsActors[i].setMapper(sphereMapper);
            pointsActors[i]
              .getProperty()
              .setColor(...colorMap[pointsColorMap.current[i]]);
            renderer.addActor(pointsActors[i]);
          }
        });
        polydata.getLines().setData(linesRef.current);
      } else {
        /**
         * 隐藏子树
         **/
        closeList.current.push(id);
        // 寻找id节点的子树
        const tree = graphRef.current.bfs(id);
        linesRef.current = linesRef.current.reduce((acc, v, index, arr) => {
          if (
            index % 3 === 0 &&
            !tree.some(
              (item) =>
                (item[0] === arr[index + 1] && item[1] === arr[index + 2]) ||
                (item[1] === arr[index + 1] && item[0] === arr[index + 2])
            ) &&
            judgeValidity(arr[index + 1]) &&
            judgeValidity(arr[index + 2])
          ) {
            acc.push(v, arr[index + 1], arr[index + 2]);
          }
          return acc;
        }, []);
        if (!sonNodeMap.current[id]) {
          // 如果对应id的子树还未建立
          sonNodeMap.current[id] = tree.reduce((acc, v) => {
            if (acc.indexOf(v[0]) < 0 && v[0] !== id) {
              // 数组中未存 & 不是父节点
              acc.push(v[0]);
            }
            if (acc.indexOf(v[1]) < 0 && v[1] !== id) {
              // 数组中未存 & 不是父节点
              acc.push(v[1]);
            }
            return acc;
          }, []);
        }
        // 删除id的子节点显示
        sonNodeMap.current[id].forEach((v) => {
          renderer.removeActor(pointsActors[v]);
          pointsActors[v].delete();
        });
        polydata.getLines().setData(linesRef.current);
      }

      actor.delete();
      mapper.delete();

      const newMapper = vtkMapper.newInstance();
      const newActor = vtkActor.newInstance();
      picker.setPickList([newActor]);
      newMapper.setInputData(polydata);
      newActor.setMapper(newMapper);
      renderer.addActor(newActor);
      renderWindow.render();
      context.current.actor = newActor;
      context.current.mapper = newMapper;
    },
    [judgeValidity]
  );

  /**
   * 初始化窗口
   */
  useEffect(() => {
    if (!context.current) {
      const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
        background: [0, 0, 0],
        rootContainer: vtkContainerRef.current,
      });
      const renderer = fullScreenRenderer.getRenderer();
      const renderWindow = fullScreenRenderer.getRenderWindow();
      const resetCamera = renderer.resetCamera;
      const render = renderWindow.render;

      let actor, mapper, polydata;
      const reader = vtkPolyDataReader.newInstance();

      (async function () {
        await reader.setUrl(`http://127.0.0.1:7001/public/vtk/st.vtk`);
        polydata = reader.getOutputData(0);
        global.polydata = polydata;

        // 处理数据
        linesRef.current = polydata.getLines().getData();
        linesCopyRef.current = polydata.getLines().getData();
        const res = await get("/getJson");
        heightListRef.current = res.data;
        displayPointsRef.current = heightListRef.current.map(
          (a, index) => index
        );

        graphRef.current = generateGraph(
          linesCopyRef.current.reduce((acc, v, index) => {
            if (index % 3 === 1) {
              acc.push([v]);
            } else if (index % 3 === 2) {
              acc[acc.length - 1].push(v);
            }
            return acc;
          }, []),
          heightListRef.current
        );

        // 处理可视化
        mapper = vtkMapper.newInstance();
        actor = vtkActor.newInstance();
        mapper.setInputData(polydata);
        actor.setMapper(mapper);
        renderer.addActor(actor);
        //添加节点显示，形状为球状
        const pointsActors = [];
        for (let i = 0; i < polydata.getNumberOfPoints(); i++) {
          const sphere = vtkSphereSource.newInstance();
          sphere.setCenter(...polydata.getPoints().getPoint(i));
          sphere.setRadius(0.15);
          const sphereMapper = vtkMapper.newInstance();
          sphereMapper.setInputData(sphere.getOutputData());
          pointsActors[i] = vtkActor.newInstance();
          pointsActors[i].setMapper(sphereMapper);
          pointsColorMap.current[i] = 0; // 第i个点的颜色类型
          pointsActors[i].getProperty().setColor(...colorMap[0]);
          renderer.addActor(pointsActors[i]);
        }
        resetCamera();
        render();

        // UI controller
        const picker = vtkPointPicker.newInstance();
        global.picker = picker;
        picker.setPickFromList(1);
        picker.initializePickList();
        picker.addPickList(actor);

        /**
         * 绑定右键单击事件
         */
        renderWindow.getInteractor().onRightButtonPress((callData) => {
          if (renderer !== callData.pokedRenderer) {
            return;
          }

          const pos = callData.position;
          const point = [pos.x, pos.y, 0.0];
          picker.pick(point, renderer);

          if (picker.getActors().length === 0) {
            // 未选中任何一个顶点
            const pickedPoint = picker.getPickPosition();
            console.log(`No point picked, default: ${pickedPoint}`);
          } else {
            // 选中了一个顶点，并取得该顶点id
            const pickedPointId = picker.getPointId();
            console.log("[Picked point id]: ", pickedPointId);
            collapseLines(pickedPointId);
            // 根据id定位该顶点
            const pickedPoint = polydata.getPoints().getPoint(pickedPointId);
            // console.log("coordinate:", pickedPoint);
            console.log("高度：", heightListRef.current[pickedPointId]);
          }
          renderWindow.render();
        });

        global.highlight = (id) => {
          const sphere = vtkSphereSource.newInstance();
          sphere.setCenter(...polydata.getPoints().getPoint(id));
          sphere.setRadius(0.3);
          const sphereMapper = vtkMapper.newInstance();
          sphereMapper.setInputData(sphere.getOutputData());
          pointsActors[id] = vtkActor.newInstance();
          pointsActors[id].setMapper(sphereMapper);
          pointsActors[id].getProperty().setColor(1, 1, 1);
          renderer.addActor(pointsActors[id]);
          renderWindow.render();
        };
        context.current = {
          fullScreenRenderer,
          renderWindow,
          renderer,
          pointsActors,
          actor,
          mapper,
          polydata,
          picker,
        };

        global.reader = reader;
        global.fullScreenRenderer = fullScreenRenderer;
      })();
    }

    return () => {
      if (context.current) {
        const { fullScreenRenderer, actor, mapper } = context.current;
        actor.delete();
        mapper.delete();
        fullScreenRenderer.delete();
        context.current = null;
      }
    };
  }, [vtkContainerRef, collapseLines]);

  const onReset = (e) => {
    lowRef.current.value = null;
    highRef.current.value = null;
    closeList.current = [];
    sonNodeMap.current = [];
    const {
      polydata,
      actor,
      mapper,
      renderer,
      renderWindow,
      picker,
      pointsActors,
    } = context.current;
    polydata.getLines().setData(linesCopyRef.current);
    displayPointsRef.current = heightListRef.current.map((v, i) => i);
    for (let i = 0; i < polydata.getNumberOfPoints(); i++) {
      renderer.removeActor(pointsActors[i]);
      pointsActors[i].delete();
      const sphere = vtkSphereSource.newInstance();
      sphere.setCenter(...polydata.getPoints().getPoint(i));
      sphere.setRadius(0.15);
      const sphereMapper = vtkMapper.newInstance();
      sphereMapper.setInputData(sphere.getOutputData());
      pointsActors[i] = vtkActor.newInstance();
      pointsActors[i].setMapper(sphereMapper);
      pointsColorMap.current[i] = 0;
      pointsActors[i].getProperty().setColor(...colorMap[0]);
      renderer.addActor(pointsActors[i]);
    }
    linesRef.current = deepClone(linesCopyRef.current);

    actor.delete();
    mapper.delete();

    const newMapper = vtkMapper.newInstance();
    const newActor = vtkActor.newInstance();
    picker.setPickList([newActor]);
    newMapper.setInputData(polydata);
    newActor.setMapper(newMapper);
    renderer.addActor(newActor);
    renderWindow.render();
    context.current.actor = newActor;
    context.current.mapper = newMapper;
  };
  const onSearchClick = (e) => {
    const {
      polydata,
      actor,
      mapper,
      renderer,
      renderWindow,
      picker,
      pointsActors,
    } = context.current;
    closeList.current = [];

    // 寻找范围内的节点
    const targetPointsList = heightListRef.current.reduce((acc, v, index) => {
      if (v > lowRef.current.value && v < highRef.current.value)
        acc.push(index);
      return acc;
    }, []);

    // 寻找包含根路径的所有节点
    const tempPointsList = graphRef.current.getCommonRootPath(
      deepClone(targetPointsList)
    );
    displayPointsRef.current = tempPointsList;

    linesRef.current = linesCopyRef.current.reduce((acc, v, index, arr) => {
      if (index % 3 === 0) {
        if (
          tempPointsList.includes(arr[index + 1]) &&
          tempPointsList.includes(arr[index + 2])
        ) {
          acc.push(2, arr[index + 1], arr[index + 2]);
        }
      }
      return acc;
    }, []);
    polydata.getLines().setData(linesRef.current);

    for (let i = 0; i < polydata.getNumberOfPoints(); i++) {
      renderer.removeActor(pointsActors[i]);
      pointsActors[i].delete();
      if (tempPointsList.includes(i)) {
        const sphere = vtkSphereSource.newInstance();
        sphere.setCenter(...polydata.getPoints().getPoint(i));
        sphere.setRadius(0.15);
        const sphereMapper = vtkMapper.newInstance();
        sphereMapper.setInputData(sphere.getOutputData());
        pointsActors[i] = vtkActor.newInstance();
        pointsActors[i].setMapper(sphereMapper);
        if (targetPointsList.includes(i)) {
          // 范围内的点是蓝色
          pointsColorMap.current[i] = 1;
          pointsActors[i].getProperty().setColor(...colorMap[1]);
        } else {
          // 范围外（根路径）是黄色
          pointsColorMap.current[i] = 0;
          pointsActors[i].getProperty().setColor(...colorMap[0]);
        }
        renderer.addActor(pointsActors[i]);
      }
    }
    actor.delete();
    mapper.delete();

    const newMapper = vtkMapper.newInstance();
    const newActor = vtkActor.newInstance();
    picker.setPickList([newActor]);
    newMapper.setInputData(polydata);
    newActor.setMapper(newMapper);
    renderer.addActor(newActor);
    renderWindow.render();
    context.current.actor = newActor;
    context.current.mapper = newMapper;
  };

  return (
    <div>
      <div ref={vtkContainerRef} />
      <table
        style={{
          position: "absolute",
          top: "25px",
          left: "25px",
          background: "white",
          padding: "12px",
        }}
      >
        <tbody>
          <tr>
            <td>
              <input type="number" step={0.1} ref={lowRef} />
              <input type="number" step={0.1} ref={highRef} />
              <button onClick={onSearchClick}>search</button>
              <button onClick={onReset} style={{ marginLeft: 12 }}>
                Reset
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default Home;
